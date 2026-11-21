// @ts-check


/**
 * @file MCP server helper (Model Context Protocol).
 * @version 0.12.0
 *
 * @description
 * Wraps the official MCP TypeScript SDK v2 server so a plugin can expose its
 * tool definitions — and optionally its resources and prompts — over stdio or
 * over the Streamable HTTP transport. `tools` is the same array shape
 * createContextTools / loadMcpTools produce (name / description / parameters /
 * execute); each tool's JSON Schema is advertised verbatim as its MCP
 * `inputSchema`, and a tool may also declare an `outputSchema`, in which case
 * the result is returned as `structuredContent` and validated against it.
 *
 * The server keeps the 2025-era session model: a client that opens with
 * `initialize` is served exactly as before. Serving the 2026-07-28 era
 * statelessly is a later change.
 */
import { randomUUID } from 'node:crypto';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { NodeStreamableHTTPServerTransport, toNodeHandler } from '@modelcontextprotocol/node';
import { ConfigurationError, BackendError } from '../core/errors.mjs';
import { ERROR_CODES } from '../core/constants/index.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { McpTaskStore, toWireTaskError } from './mcp-task-store.mjs';
import { createContextTools } from './context-tools.mjs';
import { executeTools } from './tool-execution.mjs';
import { capToolOutput } from './external-capability.mjs';
import { toWireToolParameters } from '../support/json.mjs';
import { requestHostAllowed } from '../support/utils.mjs';
import { SDK_VERSION } from '../core/constants/index.mjs';
/**
 * One resource a plugin exposes: a URI plus the reader that returns its text.
 * @typedef {Object} McpResourceDef
 * @property {string} uri
 * @property {string} [name]
 * @property {string} [description]
 * @property {string} [mimeType]
 * @property {() => Promise<string>|string} read
 */

/**
 * What a prompt renderer returns: ready MCP messages, or text this server wraps
 * as one user message.
 * @typedef {Object} McpPromptRender
 * @property {Array<Object>} [messages]
 * @property {string} [text]
 */

/**
 * One prompt a plugin exposes: a name, its declared arguments and the renderer
 * that turns them into text.
 * @typedef {Object} McpPromptDef
 * @property {string} name
 * @property {string} [description]
 * @property {Array<{name: string, description?: string, required?: boolean}>} [arguments]
 * @property {(args: Record<string, string>) => Promise<McpPromptRender>|McpPromptRender} render
 */

/**
 * The MCP server object, as this helper hands it back: connect a transport,
 * register a request handler, close. (Named structurally on purpose — the SDK's
 * own declarations pull the DOM lib in, and the published surface must not.)
 * @typedef {Object} McpServerHandle
 * @property {(transport: Object) => Promise<void>} connect
 * @property {(method: string, handler: Function) => void} setRequestHandler
 * @property {() => Promise<void>} [close]
 * @property {() => {name?: string, version?: string}} [getClientVersion] - The client the session handshook with.
 * @property {() => boolean} [hasLiveTasks] - Whether a task this server started is still running.
 */

/**
 * A transport a session owns: it serves a request and closes.
 * @typedef {Object} McpTransportLike
 * @property {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body?: unknown) => Promise<void>} handleRequest
 * @property {() => Promise<void>} close
 * @property {string} [sessionId] - The id the transport minted (stateful mode only).
 */

/**
 * One stateful MCP session: the server and the transport that own it, when it
 * last served a request (the idle sweep's clock), how many POSTs it is serving
 * right now, and whether it holds an open SSE stream. Only a POST or a live
 * task makes a session busy; a held stream does not.
 * @typedef {Object} McpHttpSession
 * @property {McpServerHandle} server
 * @property {McpTransportLike} transport
 * @property {number} lastSeenAt
 * @property {number} inFlight
 * @property {boolean} streaming
 */

/** @typedef {import('./mcp-task-store.mjs').McpTaskStoreLike} McpTaskStoreLike */

/**
 * Builds the MCP server object with the given tools, resources and prompts.
 * `taskClaims` links the shared store to the session that started each task: one
 * map per HTTP handler, one entry per created task. The map is not durable and
 * not global: a restart starts empty (so a durable store's old tasks become
 * readable), and a store shared across handlers or services is outside one
 * map's boundary, so that sharing must be the host's own decision.
 * @param {{ name?: string, version?: string, tools?: Array<import('./tool-execution.mjs').ToolDefinition>, resources?: McpResourceDef[], prompts?: McpPromptDef[], tasks?: boolean, taskStore?: McpTaskStoreLike|null, taskClaims?: Map<string, object>|null }} arg0
 * @returns {McpServerHandle}
 */
function buildServer({ name = 'merci-sdk', version = SDK_VERSION, tools = [], resources = [], prompts = [], tasks = false, taskStore = null, taskClaims = null }) {
    const taskTools = tasks && tools.some((t) => t.taskSupport && t.taskSupport !== 'forbidden');
    /** @type {Record<string, any>} */
    const capabilities = { tools: {} };
    if (resources.length) capabilities.resources = {};
    if (prompts.length) capabilities.prompts = {};
    if (taskTools) capabilities.tasks = { list: {}, cancel: {}, requests: { tools: { call: {} } } };
    const server = new Server({ name, version }, { capabilities });

    /**
     * One call's result envelope, shared by the direct and task paths.
     * @param {{tool: import('./tool-execution.mjs').ToolDefinition, args: Record<string, any>, signal: AbortSignal|null}} arg0
     * @returns {Promise<any>}
     */
    const callTool = async ({ tool, args, signal }) => {
        try {
            const [out] =  (await executeTools({ toolCalls: [{ id: /** @type {string} */ (tool.name), name: /** @type {string} */ (tool.name), arguments: args }], toolLibrary: tools, signal }));
            if (!/** @type {any} */ (out)?.success) {
                const errText = typeof /** @type {any} */ (out)?.error === 'string' ? /** @type {any} */ (out).error : JSON.stringify(/** @type {any} */ (out)?.error ?? out);
                return { content: [{ type: 'text', text: capToolOutput({ text: errText }) }], isError: true };
            }
            const raw = /** @type {any} */ (out).result;
            const structured = tool.outputSchema && raw && typeof raw === 'object' && !Array.isArray(raw)
                ? raw
                : undefined;
            const text = capToolOutput({ text: typeof raw === 'string' ? raw : JSON.stringify(raw ?? '') });
            return {
                content: [{ type: 'text', text }],
                ...(structured ? { structuredContent: structured } : {})
            };
        } catch (err) {
            return { content: [{ type: 'text', text: ( (/** @type {any} */ (err)))?.message ?? String(err) }], isError: true };
        }
    };

    // A supplied store is shared and owned by its caller: only a store this
    // server created is closed here. In-flight tasks are cancelled per id
    // either way, so a session teardown still stops what it started.
    const ownsStore = !taskStore;
    const store = taskStore ?? new McpTaskStore();
    /**
     * Which session started which task. A supplied store is shared between
     * sessions (and, for a durable store, between processes), so the store's
     * contents are not the session's: a task another session of this handler
     * started answers as unknown here. A task no session of this handler
     * started — a record a restart loaded into an empty claim map — stays
     * readable by id. A reconnect is a different session and gets nothing back
     * from the dropped one; only the restart path is readable.
     * @type {Map<string, object>}
     */
    const claims = taskClaims ?? new Map();
    /** This session's claim token: one MCP session, one buildServer call. */
    const session = {};
    /** @type {Set<string>} */
    const liveTaskIds = new Set();

    /**
     * Whether this session may act on the id.
     * @param {string} taskId
     * @returns {boolean}
     */
    const readableTask = (taskId) => {
        const claimed = claims.get(String(taskId));
        return claimed === undefined || claimed === session;
    };

    /**
     * Refuses an id this handler's other sessions started, with exactly the
     * error the store raises for a task that never existed, so neither the id's
     * existence nor its owner is disclosed.
     * @param {string} taskId
     * @returns {void}
     */
    const assertOwnTask = (taskId) => {
        if (readableTask(taskId)) return;
        throw new BackendError({
            message: `Unknown task: ${taskId}`,
            options: { code: ERROR_CODES.MCP_UNKNOWN_TASK, context: { taskId } },
        });
    };

    /**
     * One page of the tasks this session may read. The store's own `list()`
     * pages every session's tasks, so the page is built from a readable-only
     * scan; the cursor keeps the store's meaning (the last task id of the page)
     * and an expired cursor is still an error.
     * @param {{cursor?: string|null}} [arg0]
     * @returns {{tasks: Array<any>, nextCursor?: string}}
     */
    const listOwnTasks = ({ cursor = null } = {}) => {
        /** @type {any[]} */
        const all = [];
        /** @type {Set<string>} */
        const seen = new Set();
        /** @type {string|null} */
        let at = null;
        for (;;) {
            const page = store.list({ cursor: at });
            all.push(...page.tasks);
            if (!page.nextCursor || seen.has(page.nextCursor)) break;
            seen.add(page.nextCursor);
            at = page.nextCursor;
        }
        const own = all.filter((task) => readableTask(task.taskId));
        const after = cursor ? own.findIndex((task) => task.taskId === cursor) : -1;
        if (cursor && after < 0) {
            throw new BackendError({ message: `Invalid task cursor: ${cursor}`, options: { context: { cursor } } });
        }
        const pageSize = Math.max(1, Number(/** @type {any} */ (store).pageSize) || LIMITS.mcp_task_page_size);
        const start = after + 1;
        const tasks = own.slice(start, start + pageSize);
        const next = start + tasks.length;
        return { tasks, ...(next < own.length ? { nextCursor: tasks[tasks.length - 1].taskId } : {}) };
    };
    /** @param {any} task */
    const publishTask = (task) => {
        if (task.status !== 'working' && task.status !== 'input_required') liveTaskIds.delete(task.taskId);
        void server.notification(/** @type {any} */ ({ method: 'notifications/tasks/status', params: task })).catch(() => {});
    };

    /**
     * Answers one task request; a store error becomes the wire error shape
     * `toWireTaskError` defines, so an unknown task reaches the client as
     * invalid params with the domain code in `data`.
     * @param {(arg0: any) => unknown} handler
     * @returns {(request: any) => unknown}
     */
    const taskHandler = (handler) => (request) => {
        try {
            return handler(request);
        } catch (err) {
            throw toWireTaskError({ err });
        }
    };

    server.setRequestHandler('tools/list', () => (/** @type {any} */ ({
        tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema:  (toWireToolParameters({ tool: t })).parameters ?? { type: 'object', properties: {} },
            ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
            ...(t.annotations ? { annotations: t.annotations } : {}),
            ...(taskTools && t.taskSupport ? { execution: { taskSupport: t.taskSupport } } : {})
        })),
    })));

    server.setRequestHandler('tools/call', async (request, ctx) => {
        const tool = tools.find((t) => t.name === request.params.name);
        if (!tool) {
            return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
        }
        const task = /** @type {any} */ (request.params).task;
        if (taskTools && !task && tool.taskSupport === 'required') {
            return { content: [{ type: 'text', text: `Tool '${tool.name}' requires a task; call it with a task parameter.` }], isError: true };
        }
        if (taskTools && task && tool.taskSupport && tool.taskSupport !== 'forbidden') {
            const created = store.start({
                ttl: task.ttl,
                onStatus: publishTask,
                run: ({ signal }) => callTool({ tool, args: request.params.arguments ?? {}, signal }),
            });
            liveTaskIds.add(created.taskId);
            claims.set(created.taskId, session);
            // The v2 client's tools/call decoder requires `content` even for a
            // task-creation result; the task field is the payload it reads.
            return { content: [], task: created };
        }
        return callTool({ tool, args: request.params.arguments ?? {}, signal: ctx?.mcpReq?.signal ?? null });
    });

    if (taskTools) {
        server.setRequestHandler(/** @type {any} */ ('tasks/get'), taskHandler((request) => {
            assertOwnTask(request.params.taskId);
            return store.get({ taskId: request.params.taskId });
        }));
        server.setRequestHandler(/** @type {any} */ ('tasks/result'), taskHandler((request) => {
            assertOwnTask(request.params.taskId);
            return store.result({ taskId: request.params.taskId });
        }));
        server.setRequestHandler(/** @type {any} */ ('tasks/list'), taskHandler((request) => listOwnTasks({ cursor: request.params?.cursor })));
        server.setRequestHandler(/** @type {any} */ ('tasks/cancel'), taskHandler((request) => {
            assertOwnTask(request.params.taskId);
            return store.cancel({ taskId: request.params.taskId });
        }));
    }

    if (resources.length) {
        server.setRequestHandler('resources/list', () => ({
            resources: resources.map((r) => ({
                uri: r.uri,
                name: r.name ?? r.uri,
                description: r.description,
                mimeType: r.mimeType ?? 'text/plain'
            }))
        }));
        server.setRequestHandler('resources/read', async (request) => {
            const resource = resources.find((r) => r.uri === request.params.uri);
            if (!resource) {
                throw new Error(`Unknown resource: ${request.params.uri}`);
            }
            const text = await resource.read();
            return {
                contents: [{
                    uri: resource.uri,
                    mimeType: resource.mimeType ?? 'text/plain',
                    text: String(text)
                }]
            };
        });
    }

    if (prompts.length) {
        server.setRequestHandler('prompts/list', () => ({
            prompts: prompts.map((p) => ({
                name: p.name,
                description: p.description,
                arguments: p.arguments ?? []
            }))
        }));
        server.setRequestHandler('prompts/get', async (request) => {
            const prompt = prompts.find((p) => p.name === request.params.name);
            if (!prompt) {
                throw new Error(`Unknown prompt: ${request.params.name}`);
            }
            const rendered = await prompt.render(request.params.arguments ?? {});
            const messages = Array.isArray(rendered?.messages)
                ? rendered.messages
                : [{ role: 'user', content: { type: 'text', text: String(rendered?.text ?? '') } }];
            return /** @type {any} */ ({ description: prompt.description, messages });
        });
    }

    // A closing server aborts the tools it still has in flight: a task's
    // controller is the only thing that can stop a run whose client went away.
    const closeServer = server.close?.bind(server);
    /** @type {any} */ (server).close = async () => {
        if (ownsStore) store.close();
        else for (const taskId of liveTaskIds) {
            try { store.cancel({ taskId }); } catch { /* the ttl already dropped it */ }
        }
        liveTaskIds.clear();
        await closeServer?.();
    };

    // The SDK's Server is the object; its own type is not published (it pulls
    // the DOM lib into a consumer's compile through the SDK declarations).
    const handle = /** @type {McpServerHandle} */ (/** @type {unknown} */ (server));
    // The HTTP layer asks this before it evicts a session: a task's own
    // retention policy owns its lifetime, not the session sweep.
    handle.hasLiveTasks = () => liveTaskIds.size > 0;
    return handle;
}


/**
 * Creates an MCP stdio server exposing the given tools, connected to
 * stdin/stdout. Resolves once the transport is listening.
 *
 * The default (`'legacy'`) is the 2025 handshake and returns the connected SDK
 * server, so a caller can still register handlers or ask the client for
 * sampling. `mcpProtocolVersion: '2026-07-28'` uses the SDK's `serveStdio`:
 * the opening exchange selects the era (2026-07-28, or 2025 with the default
 * `legacy: 'serve'`), one instance is pinned per connection, and the returned
 * facade supports `setRequestHandler` (queued until the instance exists) and
 * `getClientVersion` after the handshake. `connect` is not available because
 * `serveStdio` owns the transport. Pass `legacy: 'reject'` to refuse a 2025
 * client instead of serving it.
 *
 * `taskStore` replaces the in-memory task store (legacy era only); a supplied
 * store is shared and must be closed by its caller.
 *
 * @param {{name?: string, version?: string, tools?: Array<import('./tool-execution.mjs').ToolDefinition>, root?: string, resources?: McpResourceDef[], prompts?: McpPromptDef[], mcpProtocolVersion?: 'legacy'|'2026-07-28', legacy?: 'serve'|'reject', taskStore?: McpTaskStoreLike|null}} arg0
 *   Defaults to `createContextTools({ root })` (read/grep/glob).
 * @returns {Promise<McpServerHandle>} The connected SDK server (or its modern facade).
 */
export async function createMcpServer({ name = 'merci-sdk', version = SDK_VERSION, tools, root, resources = [], prompts = [], mcpProtocolVersion = 'legacy', legacy = 'serve', taskStore = null } = {}) {
    if (mcpProtocolVersion !== 'legacy' && mcpProtocolVersion !== '2026-07-28') {
        throw new ConfigurationError({
            message: `mcpProtocolVersion '${mcpProtocolVersion}' is not 'legacy' or '2026-07-28'.`,
            options: { option: 'mcpProtocolVersion' },
        });
    }
    if (legacy !== 'serve' && legacy !== 'reject') {
        throw new ConfigurationError({
            message: `legacy '${legacy}' is not 'serve' or 'reject'.`,
            options: { option: 'legacy' },
        });
    }
    if (legacy === 'reject' && mcpProtocolVersion !== '2026-07-28') {
        // Rejecting 2025 clients only has a meaning when the modern era is the
        // target; with the legacy mode it would silently serve them instead.
        throw new ConfigurationError({
            message: "legacy: 'reject' requires mcpProtocolVersion: '2026-07-28'.",
            options: { option: 'legacy' },
        });
    }
    const list =  (tools ?? createContextTools({ options: { root } }));
    if (mcpProtocolVersion === '2026-07-28') {
        /** The instance `serveStdio` pins on the first message. @type {McpServerHandle|null} */
        let pinned = null;
        /** Handlers registered before the pin; replayed onto the instance. @type {Map<string, Function>} */
        const pending = new Map();
        const handle = serveStdio(() => {
            const server = buildServer({ name, version, tools: list, resources, prompts, tasks: true, taskStore });
            pinned = server;
            for (const [method, handler] of pending) server.setRequestHandler(method, handler);
            pending.clear();
            return /** @type {import('@modelcontextprotocol/server').Server} */ (/** @type {unknown} */ (server));
        }, { legacy });
        // The facade keeps the default handle's shape. `connect` is the one
        // member it cannot honour: `serveStdio` owns the transport.
        return {
            connect: async () => {
                throw new ConfigurationError({
                    message: 'The 2026-07-28 stdio mode owns its transport (serveStdio); connect() is only available in the default mode.',
                    options: { option: 'mcpProtocolVersion' },
                });
            },
            setRequestHandler: (method, handler) => {
                if (pinned) pinned.setRequestHandler(method, handler);
                else pending.set(method, handler);
            },
            close: () => handle.close(),
            getClientVersion: () => pinned?.getClientVersion?.() ?? {},
        };
    }
    const server = buildServer({ name, version, tools: list, resources, prompts, tasks: true, taskStore });

    await server.connect(new StdioServerTransport());
    return server;
}


/**
 * Creates an MCP server over the Streamable HTTP transport and returns a
 * `node:http` request handler that serves it.
 *
 * Three session models are supported:
 *
 *   - **stateful** (default): one server and transport per MCP session. The
 *     session id is minted on `initialize` and the client sends it back on
 *     every later request. Sessions are bounded: `mcp_http_sessions_max` keeps
 *     the map at a cap (the oldest session makes room) and
 *     `mcp_http_session_idle_ms` closes a session that goes quiet (a held SSE
 *     stream is not work and does not protect it), on a sweep timer as well as
 *     on the request that would exceed the cap; a session with a live task is
 *     never evicted. A supplied `taskStore` is shared, but a task is reachable
 *     only from the session that started it. A reconnect is a *different*
 *     session, so a task started over a dropped connection is not readable by
 *     the new one; with a durable store it becomes readable again only after a
 *     process restart, when the claim map is empty.
 *   - **stateless legacy** (`sessionIdGenerator: undefined`): a fresh server
 *     and transport per request. The protocol forbids reusing a stateless
 *     transport, so responses are sent as JSON instead of as an event stream.
 *   - **stateless modern** (`mcpProtocolVersion: '2026-07-28'`): the SDK's
 *     `createMcpHandler` serves the 2026-07-28 era (and 2025-era traffic
 *     statelessly) with one server per request and no session id. The 2025
 *     session model is not available in this mode.
 *
 * @param {{ name?: string, version?: string, tools?: Array<import('./tool-execution.mjs').ToolDefinition>, root?: string, resources?: McpResourceDef[], prompts?: McpPromptDef[], sessionIdGenerator?: (() => string)|undefined, allowedHosts?: string[], allowAnyHost?: boolean, mcpProtocolVersion?: 'legacy'|'2026-07-28', taskStore?: McpTaskStoreLike|null }} options
 *   Omit `sessionIdGenerator` for stateful mode (a random UUID per session);
 *   pass an explicit `undefined` for stateless legacy mode. Set
 *   `mcpProtocolVersion: '2026-07-28'` for the stateless modern mode.
 *   `taskStore` replaces the in-memory store in stateful legacy mode only: a
 *   task must outlive the request that created it.
 * @returns {Promise<{ handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>, sessions: Map<string, McpHttpSession>, close: () => Promise<void> }>}
 */
export async function createMcpHttpHandler(options = {}) {
    const {
        name = 'merci-sdk', version = SDK_VERSION, tools, root, resources = [], prompts = [],
        sessionIdGenerator, allowedHosts, allowAnyHost = false,
        mcpProtocolVersion = 'legacy', taskStore = null,
    } = options;
    if (mcpProtocolVersion !== 'legacy' && mcpProtocolVersion !== '2026-07-28') {
        throw new ConfigurationError({
            message: `mcpProtocolVersion '${mcpProtocolVersion}' is not 'legacy' or '2026-07-28'.`,
            options: { option: 'mcpProtocolVersion' },
        });
    }
    const list =  (tools ?? createContextTools({ options: { root } }));
    if (mcpProtocolVersion === '2026-07-28') {
        if (taskStore) {
            // The modern mode is stateless: one server per request, so a task
            // cannot be reached from the request that polls it.
            throw new ConfigurationError({
                message: 'taskStore is not available with mcpProtocolVersion: \'2026-07-28\'; tasks need a stateful session.',
                options: { option: 'taskStore' },
            });
        }
        const handler = createMcpHandler(() => /** @type {import('@modelcontextprotocol/server').Server} */ (/** @type {unknown} */ (buildServer({ name, version, tools: list, resources, prompts }))));
        const nodeHandler = toNodeHandler(handler);
        /** @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} */
        const handle = async (req, res) => {
            if (!requestHostAllowed({ req, allowedHosts, allowAnyHost })) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Forbidden host.' } }));
                return;
            }
            await nodeHandler(req, res);
        };
        return { handle, sessions: new Map(), close: () => handler.close() };
    }
    // An explicit `sessionIdGenerator: undefined` selects stateless mode, and a
    // destructuring default cannot tell that apart from an omitted key, so the
    // presence of the key is what decides.
    const stateless = Object.hasOwn(options, 'sessionIdGenerator') && sessionIdGenerator === undefined;
    if (stateless && taskStore) {
        throw new ConfigurationError({
            message: 'taskStore requires a stateful session; omit sessionIdGenerator (do not pass it as undefined).',
            options: { option: 'taskStore' },
        });
    }
    const generateSessionId = stateless
        ? undefined
        : (typeof sessionIdGenerator === 'function' ? sessionIdGenerator : () => randomUUID());
    /** @type {Map<string, McpHttpSession>} */
    const sessions = new Map();
    /**
     * One claim map per handler: sessions share a supplied store, not the tasks
     * in it, so a task id is reachable only from the session that created it.
     * The map dies with the handler, so a task with a durable store is readable
     * by a later process (an empty map) but not by a reconnected session of this
     * one. A store shared across handlers, processes or services crosses the
     * boundary: only sharing inside one handler is isolated.
     * @type {Map<string, object>}
     */
    const taskClaims = new Map();

    /**
     * Closes one session and drops it from the map. The transport's own
     * `onclose` and `onsessionclosed` would delete it too; the sweep does not
     * rely on either, so a transport that fails to close cannot leave the map
     * growing.
     * @param {{id: string, entry: McpHttpSession}} arg0
     * @returns {void}
     */
    const evictSession = ({ id, entry }) => {
        sessions.delete(id);
        try {
            void entry.transport.close().catch(() => {});
            void entry.server.close?.().catch(() => {});
        } catch {
            // A transport that cannot even be asked to close must not take the
            // sweep (and the process, from its timer) down with it.
        }
    };

    /**
     * Whether the sweep may close this session. A session is idle when no POST
     * is in flight and it has no live task. An open SSE stream does not protect
     * it: closing the transport ends the stream, and a held stream must not pin
     * the cap forever.
     * @param {McpHttpSession} entry
     * @returns {boolean}
     */
    const isEvictable = (entry) => entry.inFlight === 0 && entry.server.hasLiveTasks?.() !== true;

    /**
     * Enforces both session bounds: every evictable session idle past
     * `mcp_http_session_idle_ms` is closed, and when the cap would be exceeded
     * the oldest evictable session makes room. `initialize` calls this before it
     * inserts, so the cap holds on the request that reaches it rather than at
     * the next tick; the sweep timer covers sessions that simply go quiet.
     * @param {{ reserve?: number }} [arg0]
     * @returns {void}
     */
    const sweepSessions = ({ reserve = 0 } = {}) => {
        const idleMs = LIMITS.mcp_http_session_idle_ms;
        const max = Math.max(1, LIMITS.mcp_http_sessions_max);
        const now = Date.now();
        for (const [id, entry] of [...sessions]) {
            if (isEvictable(entry) && now - entry.lastSeenAt >= idleMs) evictSession({ id, entry });
        }
        while (sessions.size + reserve > max) {
            const oldest = [...sessions.entries()]
                .filter(([, entry]) => isEvictable(entry))
                .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
            if (!oldest) break;
            evictSession({ id: oldest[0], entry: oldest[1] });
        }
    };
    // An unref'd timer: a handler that is never closed must not keep the
    // process alive, and the period is the idle window itself.
    /** @type {ReturnType<typeof setInterval>|null} */
    const sweepTimer = stateless ? null : setInterval(sweepSessions, LIMITS.mcp_http_session_idle_ms);
    sweepTimer?.unref?.();

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @returns {Promise<void>}
     */
    const handle = async (req, res) => {
        if (!requestHostAllowed({ req, allowedHosts, allowAnyHost })) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Forbidden host.' } }));
            return;
        }
        const sessionId = req.headers?.['mcp-session-id'];
        const existing = sessionId ? sessions.get(String(sessionId)) : undefined;
        if (existing) {
            existing.lastSeenAt = Date.now();
            // A GET opens the long-lived notification stream. It is not work
            // the session is doing: counting it as in-flight let one stream per
            // session pin the map at the cap forever, so it is tracked apart.
            if (req.method === 'GET') {
                existing.streaming = true;
                try {
                    await existing.transport.handleRequest(req, res);
                } finally {
                    existing.streaming = false;
                }
                return;
            }
            existing.inFlight += 1;
            try {
                await existing.transport.handleRequest(req, res);
            } finally {
                existing.inFlight -= 1;
                existing.lastSeenAt = Date.now();
            }
            return;
        }

        const server = buildServer({ name, version, tools: list, resources, prompts, tasks: !stateless, taskStore, taskClaims });
        const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: generateSessionId,
            // A stateless transport cannot be reused, and its response must be
            // complete before the transport is closed — so it answers with JSON
            // instead of an event stream.
            ...(stateless ? { enableJsonResponse: true } : {}),
            ...(stateless ? {} : {
                onsessioninitialized: (/** @type {string} */ id) => {
                    sweepSessions({ reserve: 1 });
                    sessions.set(id, { server, transport, lastSeenAt: Date.now(), inFlight: 0, streaming: false });
                },
                // A DELETE from the client ends the session; without this the
                // map kept the pair forever.
                onsessionclosed: (/** @type {string} */ id) => { sessions.delete(id); },
            })
        });
        if (!stateless) {
            // Set BEFORE connect: the transport may close during the handshake,
            // and a close handler installed afterwards would miss it.
            transport.onclose = () => {
                const id = transport.sessionId;
                if (typeof id === 'string' && id.length > 0) sessions.delete(id);
            };
        }
        await server.connect(transport);
        try {
            await transport.handleRequest(req, res);
        } finally {
            if (stateless) {
                await transport.close().catch(() => {});
                await server.close?.().catch(() => {});
            }
        }
    };

    /**
     * Closes every live session and its server. The HTTP server that owns the
     * handler should await this on shutdown.
     * @returns {Promise<void>}
     */
    const close = async () => {
        if (sweepTimer) clearInterval(sweepTimer);
        for (const [id, entry] of [...sessions]) {
            sessions.delete(id);
            await entry.transport.close().catch(() => {});
            await entry.server.close?.().catch(() => {});
        }
    };

    return { handle, sessions, close };
}
