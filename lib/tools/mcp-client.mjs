// @ts-check


/**
 * @file MCP client and tool loader (Model Context Protocol).
 * @version 0.12.0
 *
 * @description
 * Wraps the official MCP TypeScript SDK v2 client
 * (`@modelcontextprotocol/client`): lifecycle (start/stop, with an optional
 * reconnect), tool listing, resource and prompt access, and tool execution
 * with output capping and `isError` mapping. Supports stdio (default),
 * Streamable HTTP, and (deprecated) SSE transports. `loadMcpTools` converts
 * remote tools into SDK tool definitions with wire-schema normalization.
 *
 * The client declares the three capabilities a server may call back on:
 * `sampling` (the server asks our model to complete something), `elicitation`
 * (the server asks the user for structured input) and `roots` (the server asks
 * which workspace directories it may read). Each is backed by a caller-supplied
 * callback; without one the callback is answered with a protocol-level refusal
 * rather than a silent success.
 *
 * `mcpProtocolVersion` selects the wire era. The default, `'legacy'`, is the
 * plain 2025 `initialize` handshake, byte-identical to v1. `'auto'` probes
 * `server/discover` and falls back to the 2025 handshake; a date string pins
 * the modern era to exactly that revision.
 */
import { SDK_VERSION } from '../core/constants/index.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { LIMIT_REGISTRY } from '../core/constants/limits.mjs';
import { AbortedError, BackendError, ConfigurationError } from '../core/errors.mjs';
import { EVENTS, emitEvent } from '../core/events.mjs';
import { sdkWarn } from '../support/utils.mjs';
import { safeChildEnv } from '../support/child-env.mjs';
import { redactUrl } from '../support/redact.mjs';
import { flattenContent, raceWithAbort } from './tool-execution.mjs';
import { fromWireTaskError } from './mcp-task-store.mjs';
import { capToolOutput } from './external-capability.mjs';

/**
 * The v2 SDK keeps the 2025-11-25 task wire schemas importable only from its
 * internal package, so the task helpers validate with a permissive schema and
 * let the server's own types describe the payload.
 * @type {import('@modelcontextprotocol/client').StandardSchemaV1}
 */
const TASK_RESULT_SCHEMA = /** @type {any} */ ({
    '~standard': { version: 1, vendor: 'merci', validate: (/** @type {unknown} */ value) => ({ value }) },
});
/**
 * A transport this wrapper drives: the SDK's stdio / HTTP / SSE transport, or a
 * test double such as `InMemoryTransport`.
 * @typedef {Object} McpTransport
 * @property {(error: Error) => void} [onerror]
 * @property {(...args: unknown[]) => Promise<void>} [start]
 * @property {(...args: unknown[]) => Promise<void>} [close]
 */

/**
 * The request envelope the SDK hands a request handler.
 * @typedef {Object} McpRequest
 * @property {Record<string, unknown>} [params]
 */

/**
 * The per-request context the SDK hands a request handler. v2 moved the
 * abort signal off `extra` and onto `ctx.mcpReq.signal`.
 * @typedef {Object} McpRequestContext
 * @property {{signal?: AbortSignal|null}} [mcpReq]
 */

/**
 * A server-initiated `sampling/createMessage`, as this wrapper forwards it.
 * @typedef {Object} McpSamplingRequest
 * @property {Array<Object>} [messages]
 * @property {Object|null} [modelPreferences]
 * @property {string|null} [systemPrompt]
 * @property {string} [includeContext]
 * @property {number|null} [maxTokens]
 * @property {AbortSignal|null} [signal]
 */

/**
 * What an `onSampling` callback answers.
 * @typedef {Object} McpSamplingResponse
 * @property {string} [role]
 * @property {Object} [content]
 * @property {string} [model]
 * @property {string} [stopReason]
 */

/**
 * A server-initiated `elicitation/create`, as this wrapper forwards it.
 * @typedef {Object} McpElicitRequest
 * @property {string} [message]
 * @property {Object|null} [requestedSchema]
 * @property {string} [mode]
 */

/**
 * What an `onElicit` callback answers.
 * @typedef {Object} McpElicitResponse
 * @property {string} [action]
 * @property {Record<string, unknown>} [content]
 */

/**
 * One workspace root advertised to the server (`roots/list`).
 * @typedef {Object} McpRoot
 * @property {string} uri
 * @property {string} [name]
 */

/**
 * Options accepted by `new McpClient(...)`.
 * @typedef {Object} McpClientOptions
 * @property {string|null} [url]
 * @property {string} [protocol]
 * @property {number} [timeout]
 * @property {import('node:events').EventEmitter<Record<string, unknown[]>>|null} [eventEmitter]
 * @property {Array<McpRoot>} [roots]
 * @property {((request: McpSamplingRequest) => McpSamplingResponse|Promise<McpSamplingResponse>)|null} [onSampling]
 * @property {((request: McpElicitRequest) => McpElicitResponse|Promise<McpElicitResponse>)|null} [onElicit]
 * @property {Record<string, string>|null} [headers]
 * @property {Object|null} [authProvider]
 * @property {number} [reconnectAttempts]
 * @property {(() => void|Promise<void>)|null} [onToolsChanged]
 * @property {((task: McpTask) => void)|null} [onTaskStatus] - Called for every
 *   `notifications/tasks/status` the server publishes (legacy task era only).
 * @property {McpTransport|null} [transport]
 * @property {string} [cwd] - Working directory for a stdio server (default: the parent's).
 * @property {'inherit'|'pipe'} [stderr] - How a stdio server's stderr is handled (default: `'inherit'`).
 * @property {boolean} [approveDestructive] - Gate every loaded tool that is not
 *   read-only (or that is destructive) behind approval. Default false.
 * @property {'legacy'|'auto'|string} [mcpProtocolVersion] - `'legacy'` (default) is the
 *   2025 `initialize` handshake; `'auto'` probes `server/discover` and falls back;
 *   any other string pins the modern era to that revision date (e.g. `'2026-07-28'`).
 *   A 2025 revision is `'legacy'`, not a pin.
 */

/**
 * The subset of the MCP SDK client this wrapper drives. Structural on purpose:
 * a type import of the SDK's `Client` would drag its DOM-global declarations
 * (`HeadersInit`, `RequestInit`, `Response`, …) into every TypeScript
 * consumer's compile — a Node consumer with `lib: ["ES2023"]` then fails.
 * @typedef {{
 *   setRequestHandler: (method: string, handler: (request: McpRequest, ctx: McpRequestContext) => Promise<unknown>) => void,
 *   setNotificationHandler: (method: string, handler: (notification: McpRequest) => void|Promise<void>) => void,
 *   connect: (transport: McpTransport) => Promise<void>,
 *   close: () => Promise<void>,
 *   getProtocolEra?: () => string|undefined,
 *   getNegotiatedProtocolVersion?: () => string|undefined
 * }} McpSdkClient
 */



/**
 * One resource as the server lists it.
 * @typedef {Object} McpResource
 * @property {string} uri
 * @property {string} [name]
 * @property {string} [description]
 * @property {string} [mimeType]
 */

/**
 * One resource's contents, as `readResource()` returns them.
 * @typedef {Object} McpResourceContents
 * @property {Array<{uri?: string, mimeType?: string, text?: string, blob?: string}>} [contents]
 */

/**
 * One prompt as the server lists it.
 * @typedef {Object} McpPrompt
 * @property {string} name
 * @property {string} [description]
 * @property {Array<Object>} [arguments]
 */

/**
 * One prompt rendered, as `getPrompt()` returns it.
 * @typedef {Object} McpPromptResult
 * @property {string} [description]
 * @property {Array<{role?: string, content?: {type?: string, text?: string}}>} [messages]
 */

/**
 * One tool as the server lists it.
 * @typedef {Object} McpTool
 * @property {string} name
 * @property {string} [description]
 * @property {Object} [inputSchema]
 * @property {{readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean}|null} [annotations]
 * @property {{taskSupport?: 'forbidden'|'optional'|'required'}} [execution] - Legacy 2025-11-25 task support.
 */

/**
 * One tool as `loadMcpTools()` returns it, with the SDK-wide teardown hook the
 * adapters call when the server goes away.
 * @typedef {Array<McpToolDefinition> & {stop?: () => Promise<void>}} McpToolSet
 */

/**
 * One SDK tool definition built from a server tool.
 * @typedef {Object} McpToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} parameters
 * @property {Function} execute
 * @property {Object} [annotations] - The server's MCP annotations, verbatim.
 * @property {boolean} [requiresApproval] - Set by `approveDestructive` for a tool that is not read-only.
 */

/**
 * The raw `tools/call` response.
 * @typedef {Object} McpToolResult
 * @property {Array<Object>} [content]
 * @property {boolean} [isError]
 * @property {unknown} [structuredContent]
 */

/**
 * A legacy 2025-11-25 task. The v2 SDK deprecates this vocabulary and ships no
 * runtime, so the client helpers below speak it directly for peers that still
 * serve it.
 * @typedef {Object} McpTask
 * @property {string} taskId
 * @property {'working'|'input_required'|'completed'|'failed'|'cancelled'} status
 * @property {number|null} ttl
 * @property {string} createdAt
 * @property {string} lastUpdatedAt
 * @property {number} [pollInterval]
 * @property {string} [statusMessage]
 */

/**
 * Byte cap on a single MCP tool result's text.
 * Code default only; the effective cap is `LIMITS.mcp_output_max_chars` (`getLimits()`).
 */
export const MCP_MAX_OUTPUT_LENGTH = LIMIT_REGISTRY.mcp_output_max_chars.default;

/** @param {{schema: *}} arg0 */
function mcpSchemaToWire({ schema }) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'object', properties: {} };
    let root = schema;
    if (root.$ref && typeof root.$ref === 'string') {
        const name = root.$ref.split('/').pop();
        root = schema.definitions?.[name] ?? schema.$defs?.[name] ?? null;
        if (!root) return { type: 'object', properties: {} };
    }
    if (root.type === 'object') return root;
    return { type: 'object', properties: { value: root } };
}



/**
 * Thin lifecycle wrapper around the MCP client. Manages connect / disconnect
 * and exposes tool listing / execution. Transport is stdio by default; pass
 * `options.url` (with `options.protocol` to opt into deprecated SSE) for a
 * remote HTTP server.
 */
export class McpClient {
    
    /**
      * @param {{command?: string|null, args?: Array<string>, options?: McpClientOptions}} arg0
     */
        constructor({ command, args = [], options = {} }) {
        this.command = command;
        this.args = args;
        this.url = options.url ?? null;
        this.protocol = options.protocol ?? 'streamable-http';
        this.timeout = options.timeout ?? LIMITS.mcp_default_timeout_ms;
        this.eventEmitter = options.eventEmitter ?? null;
        /** Workspace roots advertised to the server (`roots/list`). */
        this.roots = Array.isArray(options.roots) ? options.roots : [];
        /** Answers a server-initiated `sampling/createMessage`. */
        this.onSampling = typeof options.onSampling === 'function' ? options.onSampling : null;
        /** Answers a server-initiated `elicitation/create`. */
        this.onElicit = typeof options.onElicit === 'function' ? options.onElicit : null;
        /** Static request headers (e.g. `Authorization: Bearer …`). */
        this.headers = options.headers ?? null;
        /** An `OAuthClientProvider` for servers that require OAuth 2.1. */
        this.authProvider = options.authProvider ?? null;
        /** Reconnect attempts after a failed `start()` (0 disables). */
        this.reconnectAttempts = Number(options.reconnectAttempts ?? LIMITS.mcp_reconnect_attempts);
        /** Called when the server announces that its tool list changed. */
        this.onToolsChanged = typeof options.onToolsChanged === 'function' ? options.onToolsChanged : null;
        /** Called for every `notifications/tasks/status` the server publishes. */
        this.onTaskStatus = typeof options.onTaskStatus === 'function' ? options.onTaskStatus : null;
        /** A pre-built transport to use instead of creating one (stdio / HTTP). */
        this.transport = options.transport ?? null;
        /** Working directory for a stdio server. */
        this.cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : undefined;
        /** `'inherit'` (default) or `'pipe'` for a stdio server's stderr. */
        this.stderr = options.stderr === 'pipe' ? 'pipe' : 'inherit';
        /** Gate a loaded tool behind approval unless it is read-only. */
        this.approveDestructive = options.approveDestructive === true;
        /** Wire era: `'legacy'` (default), `'auto'`, or a pinned revision date. */
        this.mcpProtocolVersion = options.mcpProtocolVersion ?? 'legacy';
        if (typeof this.mcpProtocolVersion !== 'string' || this.mcpProtocolVersion.length === 0) {
            throw new ConfigurationError({ message: 'mcpProtocolVersion must be a non-empty string.', options: { option: 'mcpProtocolVersion' } });
        }
        // `'legacy'` already covers every 2025 revision; a date pins the modern
        // era, so a 2025 date would fail at connect with a confusing error.
        if (this.mcpProtocolVersion !== 'legacy' && this.mcpProtocolVersion !== 'auto' && !/^\d{4}-\d{2}-\d{2}$/.test(this.mcpProtocolVersion)) {
            throw new ConfigurationError({
                message: `mcpProtocolVersion '${this.mcpProtocolVersion}' is not 'legacy', 'auto' or a revision date (YYYY-MM-DD); use 'legacy' for a 2025 revision.`,
                options: { option: 'mcpProtocolVersion' },
            });
        }
        /** The SDK's own negotiation option, derived once from `mcpProtocolVersion`. */
        this._versionNegotiation = this.mcpProtocolVersion === 'legacy' || this.mcpProtocolVersion === 'auto'
            ? { mode: this.mcpProtocolVersion }
            : { mode: { pin: this.mcpProtocolVersion } };
        
        /** @type {McpSdkClient|null} */
                this._client = null;
        
        /** @type {McpTransport|null} */
                this._transport = null;
    }

    
    /**
     * Builds the transport for this client: HTTP when a `url` is configured
     * (Streamable HTTP, or opted-in SSE), otherwise stdio.
     * @returns {Promise<McpTransport>}
     */
    async _createTransport() {
        if (this.transport) return this.transport;
        if (this.url) {
            const { SSEClientTransport, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
            const requestInit = this.headers ? { headers: this.headers } : undefined;
            if (this.protocol === 'sse') {
                return new SSEClientTransport(new URL(this.url), { ...(requestInit ? { requestInit } : {}), ...(this.authProvider ? { authProvider: /** @type {any} */ (this.authProvider) } : {}) });
            }
            return new StreamableHTTPClientTransport(new URL(this.url), {
                ...(requestInit ? { requestInit } : {}),
                ...(this.authProvider ? { authProvider: /** @type {any} */ (this.authProvider) } : {})
            });
        }
        const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
        // The SDK's own allowlist has no hook: merge the locale/timezone
        // variables here or the child formats dates in the C locale.
        return new StdioClientTransport({
            command: /** @type {string} */ (this.command),
            args: this.args,
            env: safeChildEnv(),
            ...(this.cwd ? { cwd: this.cwd } : {}),
            ...(this.stderr === 'pipe' ? { stderr: 'pipe' } : {}),
        });
    }

    
    /**
     * @param {{name: string, payload?: Record<string, unknown>}} arg0
     */
    _emit({ name, payload }) {
        emitEvent({ emitter: this.eventEmitter, name, payload });
    }

    /**
     * Registers the handlers a server may call back on: sampling, elicitation
     * and roots. A callback that is not configured answers with a protocol-level
     * refusal instead of pretending the request succeeded.
     * @returns {void}
     */
    _registerServerCallbacks() {
        const client = this._client;
        if (!client) return;

        // A handler may only be registered for a capability the client has
        // announced: the protocol rejects a handler without its capability.
        const onSampling = this.onSampling;
        if (onSampling) {
            client.setRequestHandler('sampling/createMessage', async (request, ctx) => {
                const params = /** @type {Record<string, any>} */ (request.params ?? {});
                const result = await onSampling({
                    messages: params.messages ?? [],
                    modelPreferences: params.modelPreferences ?? null,
                    systemPrompt: params.systemPrompt ?? null,
                    includeContext: params.includeContext ?? 'none',
                    maxTokens: params.maxTokens ?? null,
                    signal: ctx?.mcpReq?.signal ?? null
                });
                return {
                    role: result?.role ?? 'assistant',
                    content: result?.content ?? { type: 'text', text: '' },
                    model: result?.model ?? 'merci-sdk',
                    stopReason: result?.stopReason ?? 'endTurn'
                };
            });
        }

        const onElicit = this.onElicit;
        if (onElicit) {
            client.setRequestHandler('elicitation/create', async (request) => {
                const params = /** @type {any} */ (request.params ?? {});
                const result = await onElicit({
                    message: params.message ?? '',
                    requestedSchema: params.requestedSchema ?? null,
                    mode: params.mode ?? 'form'
                });
                if (result?.action) return result;
                return { action: 'accept', content: result?.content ?? {} };
            });
        }

        if (this.roots.length) {
            client.setRequestHandler('roots/list', async () => ({ roots: this.roots }));
        }

        client.setNotificationHandler('notifications/tools/list_changed', async () => {
            this._emit({ name: EVENTS.MCP.TOOLS_CHANGED, payload: {} });
            if (this.onToolsChanged) await this.onToolsChanged();
        });

        // The server publishes this on every task transition; without a
        // handler the v2 client drops it silently.
        client.setNotificationHandler('notifications/tasks/status', (notification) => {
            const task = /** @type {any} */ (notification.params);
            this._emit({ name: EVENTS.MCP.TASK_STATUS, payload: task });
            this.onTaskStatus?.(task);
        });
    }

    
    /**
     * Connects the configured transport and registers the client.
     * @returns {Promise<void>}
     */
        async start() {
        /** @type {Record<string, any>} */
        const capabilities = {};
        if (this.onSampling) capabilities.sampling = {};
        if (this.onElicit) capabilities.elicitation = {};
        if (this.roots.length) capabilities.roots = { listChanged: false };
        const [{ Client }, transport] = await Promise.all([
            import('@modelcontextprotocol/client'),
            this._createTransport()
        ]);
        const client = new Client(
            { name: 'merci-sdk', version: SDK_VERSION },
             /** @type {any} */
                          ({
                              capabilities,
                              // A probing mode inherits the 60 s request timeout
                              // by default; a silent legacy server would stall
                              // every connect that long before falling back.
                              versionNegotiation: this.mcpProtocolVersion === 'legacy'
                                  ? this._versionNegotiation
                                  : { ...this._versionNegotiation, probe: { timeoutMs: LIMITS.mcp_probe_timeout_ms } },
                          })
        );
        this._client = /** @type {McpSdkClient} */ (/** @type {unknown} */ (client));
        this._transport = transport;
        transport.onerror = /** @type {(...args: any[]) => any} */ (( err) => {
            sdkWarn({ prefix: 'MCP', args: [`MCP transport error: ${err?.message || err}`] });
            this._emit({ name: EVENTS.MCP.SERVER_ERROR, payload: { error: err?.message ?? String(err) } });
        });
        // The handlers must be registered BEFORE connect(): the official
        // client sends `notifications/initialized` while connect() resolves, and
        // an eager server can sample in that very moment.
        this._registerServerCallbacks();
        await client.connect(/** @type {any} */ (transport));
        // Origin only, and no argv: a remote server's `?token=` and a stdio
        // server's token-on-argv must not reach a log or telemetry sink (G2-9).
        this._emit({ name: EVENTS.MCP.SERVER_START, payload: {
            ...(this.url ? { url: redactUrl({ url: this.url }), protocol: this.protocol } : { command: this.command }),
            era: client.getProtocolEra?.() ?? null,
            protocolVersion: client.getNegotiatedProtocolVersion?.() ?? null,
        } });
    }

    
    /**
     * Connects, retrying with backoff when `reconnectAttempts` is set.
     * @returns {Promise<void>}
     */
    async connect() {
        const attempts = Math.max(0, Number(this.reconnectAttempts ?? 0));
        let lastError = null;
        for (let attempt = 0; attempt <= attempts; attempt++) {
            try {
                await this.start();
                return;
            } catch (err) {
                lastError = err;
                this._client = null;
                this._transport = null;
                if (attempt === attempts) break;
                const delay = LIMITS.mcp_reconnect_base_delay_ms * (attempt + 1);
                this._emit({ name: EVENTS.MCP.SERVER_RETRY, payload: { attempt: attempt + 1, delayMs: delay, error: (/** @type {any} */ (err))?.message ?? String(err) } });
                await new Promise((r) => setTimeout(r, delay));
            }
        }
        throw lastError ?? new Error('MCP connection failed.');
    }

    
    /**
     * One list verb: the v2 SDK walks every page when it is called without a
     * cursor (and caps the walk at `listMaxPages`, throwing rather than
     * truncating), so this only names the response field and emits the event.
     * @template T
     * @param {{method: 'listTools'|'listResources'|'listPrompts'|'listResourceTemplates', field: string, event?: string}} arg0
     * @returns {Promise<Array<T>>}
     */
    async _listAll({ method, field, event }) {
        const client = /** @type {any} */ (this._client);
        const response = await client[method]();
        const items = /** @type {Array<T>} */ (response?.[field] ?? []);
        if (event) this._emit({ name: event, payload: { count: items.length } });
        return items;
    }

    /**
     * Lists the server's tools.
     * @returns {Promise<Array<McpTool>>}
     */
    async getTools() {
        return this._listAll({ method: 'listTools', field: 'tools', event: EVENTS.MCP.TOOLS_FETCHED });
    }

    
    /**
     * Lists the resources the server exposes.
     * @returns {Promise<Array<McpResource>>}
     */
    async listResources() {
        return this._listAll({ method: 'listResources', field: 'resources', event: EVENTS.MCP.RESOURCES_FETCHED });
    }

    /**
     * Lists the resource URI templates the server exposes.
     * @returns {Promise<Array<{uriTemplate: string, name?: string, description?: string, mimeType?: string}>>}
     */
    async listResourceTemplates() {
        return this._listAll({ method: 'listResourceTemplates', field: 'resourceTemplates' });
    }

    
    /**
     * Reads one resource.
     * @param {{ uri: string }} arg0
     * @returns {Promise<McpResourceContents>}
     */
        async readResource({ uri }) {
        const response =  (await (/** @type {any} */ (this._client)).readResource({ uri }));
        this._emit({ name: EVENTS.MCP.RESOURCE_READ, payload: { uri } });
        return response;
    }

    
    /**
     * Lists the prompts the server exposes.
     * @returns {Promise<Array<McpPrompt>>}
     */
    async listPrompts() {
        return this._listAll({ method: 'listPrompts', field: 'prompts', event: EVENTS.MCP.PROMPTS_FETCHED });
    }

    
    /**
     * Gets one prompt, rendered with the given arguments.
     * @param {{ name: string, args?: Record<string, string> }} arg0
     * @returns {Promise<McpPromptResult>}
     */
        async getPrompt({ name, args = {} }) {
        const response =  (await (/** @type {any} */ (this._client)).getPrompt({ name, arguments: args }));
        this._emit({ name: EVENTS.MCP.PROMPT_FETCHED, payload: { name } });
        return response;
    }

    
    /**
     * @param {{name: string, args: Record<string, unknown>, signal?: AbortSignal|null, timeout?: number, idempotencyKey?: string}} arg0 -
     * @returns {Promise<McpToolResult>} The raw call response ({ content, isError, structuredContent }).
     */
        async executeTool({ name, args, signal = null, timeout = this.timeout, idempotencyKey = undefined }) {
        const started = Date.now();
        this._emit({ name: EVENTS.MCP.CALL_START, payload: { name } });
        try {
            const response =  (await (/** @type {any} */ (this._client)).callTool(
                { name, arguments: args, ...(idempotencyKey ? { _meta: { idempotencyKey } } : {}) },
                {
                    signal: signal ?? undefined,
                    timeout,
                    // A long tool that reports progress is alive: reset the
                    // timeout on each notification instead of killing it.
                    resetTimeoutOnProgress: true,
                    onprogress: (/** @type {any} */ progress) => {
                        this._emit({ name: EVENTS.MCP.CALL_PROGRESS, payload: {
                            name,
                            progress: progress?.progress ?? null,
                            total: progress?.total ?? null,
                            message: progress?.message ?? null,
                        } });
                    },
                },
            ));
            this._emit({ name: EVENTS.MCP.CALL_END, payload: { name, durationMs: Date.now() - started } });
            return response;
        } catch (error) {
            this._emit({ name: EVENTS.MCP.CALL_ERROR, payload: {
                name, error: (/** @type {any} */ (error))?.message ?? String(error), durationMs: Date.now() - started
            } });
            // v2 reports a caller cancellation as a request timeout, which is
            // indistinguishable from a real timeout by code. The caller's own
            // signal is the reliable fact, so surface the v1 `AbortError`.
            if (signal?.aborted) throw new AbortedError({ message: 'Request aborted', options: { cause: error } });
            throw error;
        }
    }

    
    /**
     * One `tasks/*` request. The store's domain code rides in `error.data`
     * (JSON-RPC reserves `error.code` for a number), so `fromWireTaskError`
     * restores it as a `BackendError` code a caller can branch on.
     * @param {{method: string, params: Record<string, unknown>, signal?: AbortSignal|null, timeout?: number}} arg0
     * @returns {Promise<unknown>}
     */
    async _taskRequest({ method, params, signal = null, timeout = this.timeout }) {
        try {
            return await (/** @type {any} */ (this._client)).request(
                { method, params },
                TASK_RESULT_SCHEMA,
                { signal: signal ?? undefined, timeout },
            );
        } catch (err) {
            throw fromWireTaskError({ error: err });
        }
    }

    /**
     * Starts a tool call as a legacy 2025-11-25 task. Only a peer on that era
     * serves it; the modern era removed the vocabulary.
     * @deprecated The 2025-11-25 task vocabulary is deprecated; it is kept for
     *   peers that still serve it and will be removed with them.
     * @param {{name: string, args?: Record<string, unknown>, ttl?: number, signal?: AbortSignal|null, timeout?: number}} arg0
     * @returns {Promise<McpTask>}
     */
        async startToolTask({ name, args = {}, ttl, signal = null, timeout = this.timeout }) {
        const response = /** @type {any} */ (await (/** @type {any} */ (this._client)).callTool(
            { name, arguments: args, task: ttl != null ? { ttl } : {} },
            { signal: signal ?? undefined, timeout },
        ));
        if (!response?.task || typeof response.task.taskId !== 'string') {
            const text = Array.isArray(response?.content)
                ? response.content.map((/** @type {any} */ block) => block?.text ?? '').filter(Boolean).join(' ')
                : '';
            throw new BackendError({
                message: `Tool '${name}' did not start a task${text ? `: ${text}` : '.'}`,
                options: { context: { tool: name } },
            });
        }
        this._emit({ name: EVENTS.MCP.CALL_START, payload: { name, task: response.task.taskId } });
        return response.task;
    }

    /**
     * Polls a task until it leaves `working`/`input_required`, then returns it.
     * The caller still calls `getTaskResult` for the payload.
     * @deprecated See `startToolTask`.
     * @param {{taskId: string, signal?: AbortSignal|null, maxWaitMs?: number, pollInterval?: number|null}} arg0
     * @returns {Promise<McpTask>}
     */
        async waitForTask({ taskId, signal = null, maxWaitMs = LIMITS.mcp_task_wait_ms, pollInterval = null }) {
        const started = Date.now();
        for (;;) {
            const task = await this.getTask({ taskId, signal });
            if (task.status !== 'working' && task.status !== 'input_required') return task;
            const elapsed = Date.now() - started;
            if (elapsed >= maxWaitMs) {
                throw new BackendError({ message: `Task ${taskId} did not finish within ${maxWaitMs} ms.`, options: { context: { taskId } } });
            }
            const waitMs = Math.min(
                Math.max(0, Number(pollInterval) || Number(task.pollInterval) || LIMITS.mcp_task_poll_ms),
                maxWaitMs - elapsed,
            );
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, waitMs);
                signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(new AbortedError({ message: 'Request aborted' }));
                }, { once: true });
            });
        }
    }

    /**
     * @deprecated See `startToolTask`.
     * @param {{taskId: string, signal?: AbortSignal|null, timeout?: number}} arg0
     * @returns {Promise<McpTask>}
     */
        async getTask({ taskId, signal = null, timeout = this.timeout }) {
        return /** @type {McpTask} */ (await this._taskRequest({ method: 'tasks/get', params: { taskId }, signal, timeout }));
    }

    /**
     * @deprecated See `startToolTask`.
     * @param {{taskId: string, signal?: AbortSignal|null, timeout?: number}} arg0
     * @returns {Promise<McpToolResult>}
     */
        async getTaskResult({ taskId, signal = null, timeout = this.timeout }) {
        return /** @type {McpToolResult} */ (await this._taskRequest({ method: 'tasks/result', params: { taskId }, signal, timeout }));
    }

    /**
     * One page of tasks. Pass the previous page's `nextCursor` to continue.
     * @deprecated See `startToolTask`.
     * @param {{cursor?: string|null, signal?: AbortSignal|null, timeout?: number}} [arg0]
     * @returns {Promise<{tasks: Array<McpTask>, nextCursor?: string}>}
     */
        async listTasks({ cursor = null, signal = null, timeout = this.timeout } = {}) {
        return /** @type {{tasks: Array<McpTask>, nextCursor?: string}} */ (await this._taskRequest({
            method: 'tasks/list',
            params: cursor ? { cursor } : {},
            signal,
            timeout,
        }));
    }

    /**
     * @deprecated See `startToolTask`.
     * @param {{taskId: string, signal?: AbortSignal|null, timeout?: number}} arg0
     * @returns {Promise<McpTask>}
     */
        async cancelTask({ taskId, signal = null, timeout = this.timeout }) {
        return /** @type {McpTask} */ (await this._taskRequest({ method: 'tasks/cancel', params: { taskId }, signal, timeout }));
    }

    /**
     * Closes the client and transport (kills the child, cancels in-flight work).
     * @returns {Promise<void>}
     */
        async stop() {
        if (this._client) {
            await (this._client).close().catch(() => {});
            this._client = null;
            this._transport = null;
            this._emit({ name: EVENTS.MCP.SERVER_STOP, payload: {} });
        }
    }
}


/**
 * (schema normalization + output capping). Teardown is guaranteed on any
 * failure, and the error is re-thrown.
 * @param {{mcpClient: McpClient}} arg0 -
 * @returns {Promise<McpToolSet>}
 */
export async function loadMcpTools({ mcpClient }) {
    // `connect` adds the reconnect policy; older clients only expose `start`.
    if (typeof mcpClient.connect === 'function') await mcpClient.connect();
    else await mcpClient.start();
    try {
        const remoteTools =  (await mcpClient.getTools());
        const approveDestructive = mcpClient.approveDestructive === true;
        /** @type {McpToolSet} */
        const tools = remoteTools.map(( t) => {
            const annotations = t.annotations && typeof t.annotations === 'object' ? t.annotations : undefined;
            // `readOnlyHint` defaults to false and `destructiveHint` to true, so a
            // tool that declares nothing is treated as write-capable. `idempotent`
            // is never derived from these hints: they come from the server.
            const readOnly = annotations?.readOnlyHint === true;
            const destructive = annotations?.destructiveHint === true;
            return {
                name: t.name,
                description: t.description || `MCP tool: ${t.name}`,
                parameters: mcpSchemaToWire({ schema: t.inputSchema }),
                // A read-only tool has no side effect, so a failed row may retry.
                // A write-capable tool never can: the server's `idempotentHint` is
                // a hint, not a contract we can enforce (G1-2).
                ...(readOnly ? { idempotent: true } : {}),
                ...(annotations ? { annotations } : {}),
                ...(approveDestructive && (destructive || !readOnly) ? { requiresApproval: true } : {}),
                /** @param {{args: *, signal: *, context?: *}} arg0 */
                execute: async ({ args, signal, context = {} }) => {
                    const run = async () => {
                        const response =  (await mcpClient.executeTool({ name: t.name, args, signal, idempotencyKey: context?.idempotencyKey }));
                        const blocks = Array.isArray(response.content) ? /** @type {Array<any>} */ (response.content) : [];
                        // An image block is data the model can see on a backend
                        // whose tool-result wire carries it; stringifying it would
                        // only ship base64 as text.
                        const images = blocks.filter((b) => b?.type === 'image' && typeof b.data === 'string');
                        const nonImage = images.length > 0 ? blocks.filter((b) => b?.type !== 'image') : response.content;
                        let text = flattenContent({ result: nonImage });
                        if (typeof text !== 'string') text = Array.isArray(nonImage) && nonImage.length === 0 ? '' : JSON.stringify(text);
                        if (response.structuredContent !== undefined && response.structuredContent !== null) {
                            const structuredStr = JSON.stringify(response.structuredContent);
                            text = text ? `${text}\n${structuredStr}` : structuredStr;
                        }
                        const capped = capToolOutput({ text, maxLength: LIMITS.mcp_output_max_chars });
                        if (response.isError) {
                            return { success: false, error: String(capped ?? '') || 'MCP tool returned an error.' };
                        }
                        return {
                            success: true,
                            result: images.length > 0
                                ? [
                                    ...(capped ? [{ type: 'text', text: String(capped) }] : []),
                                    ...images.map((b) => ({ type: 'image', data: b.data, mimeType: b.mimeType || 'image/png' })),
                                ]
                                : capped,
                        };
                    };
                    // A pre-cancelled call must not start the tool; a cancel
                    // that lands mid-flight rejects through the shared race.
                    if (signal?.aborted) throw new AbortedError({ message: 'Aborted' });
                    return raceWithAbort({ promise: run(), signal });
                }
            };
        });
        tools.stop = () => mcpClient.stop().catch(() => {});
        return tools;
    } catch (err) {
        if (typeof mcpClient._emit === 'function') {
            mcpClient._emit({ name: EVENTS.MCP.SERVER_ERROR, payload: { error: (/** @type {any} */ (err))?.message ?? String(err) } });
        }
        await mcpClient.stop().catch(() => {});
        throw err;
    }
}


/**
 * Loads a remote MCP server's tools.
 * @param {{ command?: string, args?: Array<string>, options?: McpClientOptions }} arg0
 * @returns {Promise<McpToolSet>}
 */
export async function loadMcpToolsFrom({ command, args = [], options = {} } = {}) {
    const client = new McpClient({ command, args, options });
    return loadMcpTools({ mcpClient: client });
}
