// @ts-check
import { randomUUID } from 'node:crypto';
import { ChatSessionBuilder } from './chat-session-builder.mjs';
import { AGENT_PLAN } from './plan/component.mjs';
import { CONVERSATION_SUMMARY_MARKER } from '../core/prompts.mjs';
import { buildEnvironmentBlock, discoverInstructions } from './context.mjs';
import {
    XML_TOOL_CALL_TAGS,
    FINAL_ITERATION_REMINDER,
    PLAN_MODE_REMINDER,
    BUILD_SWITCH_REMINDER,
    SYSTEM_MESSAGE_MERGE_SEPARATOR,
    ProviderType,
    StandardType,
    isStandard,
    standardFor,
    INJECTION_META_KEY,
    MERCI_NATIVE_KEY,
    TIMEOUT_CODES
} from '../core/constants/index.mjs';
import { createUserMessage, createAssistantMessage, createToolCallMessage, createToolResultMessage, attachNative } from '../messaging/messages.mjs';
import { isUserRow, isSystemRow } from '../messaging/row-shape.mjs';
import { UnifiedParameterBuilder, warnRefusedSpecKeys } from '../messaging/unified-parameter.mjs';
import { createStreamingRetryPolicy, runWithRetry, runGuardedStep, BREAKER_OPEN_CODE, hasTimeoutCode } from '../support/retry-policy.mjs';
import { InactivityTimeoutPolicy } from '../support/stream-timeout.mjs';
import { EventEmitterApiObserver } from '../support/api-observer.mjs';
import { getErrorStatus, sdkWarn, sdkError } from '../support/utils.mjs';
import { throwIfAborted, streamErrorToRetryError } from './agentic-core.mjs';
import { objectiveBlock, OBJECTIVE_TAG } from './agent-context.mjs';
import { runObjectivePass, objectiveProgressDigest } from './objective.mjs';
import { AbstractMethodError, ConfigurationError, isAbortError } from '../core/errors.mjs';
import { raceWithAbort } from '../tools/tool-execution.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { EVENTS, RunContext, emitEvent } from '../core/events.mjs';
import { STOP, HOOKS } from '../core/hooks.mjs';



/**
 * @file Abstract backend ChatSession — the step engine + system-context assembly.
 * @version 0.12.0
 *
 * @description
 * AbstractChatSession extends ChatSessionBuilder with the per-step execution
 * engine (build vendor request → consume stream → format messages), the
 * whole-history system-context rebuild (_prepareStepMessages) and the
 * overridable hook points. BaseChatSession is the shared OAI-family
 * implementation (oai/gai/aai) that wires backend-specific adapters and
 * parameter translators.
 */

/**
 * The last block of a message row, as an adapter would carry it. Used as the cache
 * anchor (wave 4, 4.2). A descriptor rather than an index: the adapter's own
 * normalizer merges consecutive same-role rows, so the stable tail and the
 * volatile block can end up as two blocks of one wire message. A tool round ends
 * on a `tool_result`/`tool_use` block, which carries an id and no text, so the
 * descriptor has two shapes.
 * @param {any} row
 * @returns {{text: string}|{toolUseId: string}|null}
 */
function lastBlockAnchor(row) {
    if (!row || typeof row !== 'object') return null;
    // JAI/tool-round rows carry the id on the row itself, not in `content`.
    if (row.type === 'tool_message' && typeof row.id === 'string') return { toolUseId: row.id };
    if ((row.type === 'assistant_message_tool' || row.type === 'assistant_tool_call') && typeof row.id === 'string') {
        return { toolUseId: row.id };
    }
    const content = row.content;
    if (typeof content === 'string') return content ? { text: content } : null;
    for (const list of [Array.isArray(content) ? content : null, Array.isArray(row.parts) ? row.parts : null]) {
        if (!list) continue;
        for (let i = list.length - 1; i >= 0; i--) {
            const part = list[i];
            if (!part || typeof part !== 'object') continue;
            if (typeof part.tool_use_id === 'string') return { toolUseId: part.tool_use_id };
            if (part.functionResponse && typeof part.functionResponse.id === 'string') return { toolUseId: part.functionResponse.id };
            if (typeof part.text === 'string' && part.text) return { text: part.text };
            if (typeof part.id === 'string' && /tool/i.test(String(part.type ?? ''))) return { toolUseId: part.id };
        }
    }
    return null;
}


/**
 * null for any other first event. The synthesized error is built by
 * `streamErrorToRetryError` in `outcomes.mjs`, so `step()` and the loop's
 * mid-stream `streamError` branch produce the same retryable error.
 * @param {{first: IteratorResult<any>}} arg0 -
 * @returns {(Error & { streamEvent?: any, nonRetryable?: boolean, status?: number, code?: string })|null}
 */
function firstEventRetryError({ first }) {
    const ev = first && !first.done ? first.value : null;
    if (!ev || ev.type !== 'error') return null;
    return streamErrorToRetryError({ error: ev });
}


/**
 * True for the JAI `PrematureEnd` reason that means moderation: the gateway
 * sends `content_filter` (or `ContentFilter`); every other reason, notably
 * `Unknown`, is an unclassified early stop, not a moderation block.
 * @param {{reason?: string}} arg0 -
 * @returns {boolean}
 */
export function isContentFilterReason({ reason }) {
    return String(reason ?? '').toLowerCase().replace(/[^a-z]/g, '').startsWith('contentfilter');
}


/**
 * One unified step event. Structural on purpose: the exact payload set is
 * per-adapter, and a consumer switches on `type` and reads one or two fields.
 * `calls` / `usage` are the vendor payloads after the adapter's normalisation.
 * @typedef {Object} StepEvent
 * @property {string} type
 * @property {string|null} [content]
 * @property {Array<Object>} [calls]
 * @property {Object} [usage]
 * @property {Object} [data]
 * @property {string|null} [thoughtSignature]
 * @property {Object} [error]
 */

/**
 * The value a `step()` generator returns when it is done.
 * @typedef {Object} StepFinalState
 * @property {string} [content]
 * @property {Array<Object>} [messages]
 * @property {Object} [usage]
 * @property {boolean} [unhandledToolCalls]
 * @property {boolean} [truncated] - The step's answer is incomplete.
 * @property {boolean} [contentFiltered] - The provider stopped it on content moderation.
 * @property {'length'|'premature_end'} [truncatedBy] - What cut the answer: the model's token limit or the provider closing the stream.
 * @property {boolean} [done] - True when the turn finished (the JAI stream's own flag).
 * @property {{error_message?: string, error_type?: string}|null} [streamError] - The vendor stream's failure, when it reported one.
 */

/**
 * A tool call as a row carries it (the unified shape, not the wire shape).
 * @typedef {Object} ToolCall
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [tool_call_id]
 * @property {Object} [function]
 * @property {string|Object} [args]
 * @property {string} [thoughtSignature]
 */

/**
 * One conversation row as the session stores it. A typedef (not an interface),
 * so it keeps the implicit index signature the adapters rely on: they add
 * vendor keys and pass rows back as records.
 * @typedef {Object} ChatRow
 * @property {string} [role]
 * @property {string} [type]
 * @property {string|Array<Object>|null} [content]
 * @property {Array<ToolCall>} [tool_calls]
 * @property {Array<Object>} [parts]
 * @property {string} [tool_call_id]
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [toolName]
 * @property {string|Object|null} [result]
 * @property {string|Object} [args]
 * @property {string} [merciId]
 * @property {string|null} [thoughtSignature]
 * @property {string} [thought_signature]
 * @property {string} [reasoningContent]
 * @property {string} [reasoning_content]
 */

/**
 * The options `step()` accepts. Explicit fields, because a caller reads them
 * back through `_onStepWillStart`.
 * @typedef {Object} StepOptions
 * @property {boolean} [forceTextResponse]
 * @property {boolean} [toolChoiceRequired]
 * @property {string|null} [thoughtSignature]
 * @property {boolean} [isLastIteration]
 * @property {AbortSignal} [signal]
 * @property {RunContext|null} [runContext]
 * @property {number|null} [maxOutputTokens]
 */

/**
 * The per-backend adapter the session calls. The four adapters share the shape
 * but not the signatures, so the members are `Function`: a precise alias would
 * be a lie the compiler cannot keep.
 * @typedef {Object} StepAdapter
 * @property {string} [vendorName]
 * @property {Function} buildVendorRequest
 * @property {Function} consumeStream
 * @property {Function} executeVendorRequest
 * @property {Function} extractXmlToolCalls
 * @property {Function} formatToolCall
 */

/**
 * The client a session talks to. Structural: the four backends share no base
 * class, and a session only needs these members.
 * @typedef {Object} SessionClient
 * @property {string} [provider]
 * @property {Function} [session]
 * @property {Function} [sessionWithId]
 * @property {import('node:events').EventEmitter} [eventEmitter]
 */

/**
 * The retry policy the session calls. Only `shouldRetry` is read here; the
 * policy owns the delay and the attempt accounting.
 * @typedef {Object} RetryPolicyLike
 * @property {Function} shouldRetry
 */

/**
 * The stream-inactivity wrapper (`InactivityTimeoutPolicy` or a custom one).
 * @typedef {Object} StreamTimeoutPolicyLike
 * @property {Function} [wrapStream]
 * @property {number} [timeoutMs]
 * @property {number} [firstChunkMs]
 */

/**
 * The API observer the session reports to (`EventEmitterApiObserver` or a
 * custom one). Every member is optional: an observer may implement a subset.
 * @typedef {Object} ApiObserverLike
 * @property {Function} onRequest
 * @property {Function} onResponse
 * @property {Function} onError
 * @property {Function} onRetry
 */

/**
 * What an adapter's `buildVendorRequest` returns: the wire body plus the
 * observability snapshot a `request:after` hook and an API observer read.
 * @typedef {Object} VendorRequest
 * @property {Object} request
 * @property {Object|null} [observability]
 */

/**
 * The vendor-native payload an assistant row may carry (a Responses-API item
 * list, a Gemini parts list, …). Structural: each backend fills what it has.
 * @typedef {Object} NativePayload
 * @property {string} provider
 * @property {string|null} protocol
 * @property {Array<Object>} items
 */

/**
 * One tool result as the loop hands it back to the session.
 * @typedef {Object} ToolResult
 * @property {string} [id]
 * @property {string} [tool_call_id]
 * @property {string} [name]
 * @property {string|Array<Object>|null} [content]
 * @property {boolean} [success]
 * @property {Object} [result]
 * @property {string|Object} [error]
 */

/**
 * The shape the first-event reader returns: the stream's first yield, or a
 * synthesised `{ done:false, value }` from a recoverable stream error.
 * @typedef {Object} FirstEventResult
 * @property {boolean} done
 * @property {Object} [value]
 */

/**
 * The abort/timeout knobs a single guarded call carries.
 * @typedef {Object} StepCallContext
 * @property {AbortSignal|null} [signal]
 * @property {number|null} [maxElapsedMs]
 * @property {string|null} [vendorName]
 * @property {import('../core/events.mjs').RunContext|null} [runContext] - The step's run, so a retry lands on its own API call.
 */

/**
 * The abstract ChatSession: builder configuration plus the step() generator.
 * Each backend subclasses it and sets `_adapter` (and the other hooks) to
 * provide the vendor-specific behavior. `step()` is the one-wire-request
 * primitive; `run()` (from the builder) drives the full agentic loop.
 * @extends {ChatSessionBuilder}
 */
export class AbstractChatSession extends ChatSessionBuilder {
    /** @type {boolean} */
    _planHandoff = false;
    
    /**
     * (`{ provider, model, eventEmitter, client, vendorClient?, retryPolicy?, streamTimeoutPolicy?, apiObserver? }`).
     * @param {{provider?: string, model: string, eventEmitter: import('node:events').EventEmitter|null, client: SessionClient|null|undefined, vendorClient?: Object|null, builderStandard?: string, retryPolicy?: Object, streamTimeoutPolicy?: Object, apiObserver?: Object, sessionId?: string|null}} arg0 - ProviderType of this session, or the options object.
         */
        constructor({ provider, model, eventEmitter, client, vendorClient = null, builderStandard, retryPolicy = createStreamingRetryPolicy(), streamTimeoutPolicy = new InactivityTimeoutPolicy(), apiObserver, sessionId = null }) {
        apiObserver = apiObserver ?? new EventEmitterApiObserver({ emitter: eventEmitter });
        super();
        this.provider = /** @type {string} */ (provider);
        this.standard = builderStandard ?? standardFor({ provider }) ?? '';
        this.model = model;
        this.eventEmitter = eventEmitter;
        this.client = client;
        this._vendorClient = vendorClient;
        
        /** @type {RetryPolicyLike|null} */
                this._retryPolicy = /** @type {RetryPolicyLike} */ (retryPolicy);
        
        /** @type {StreamTimeoutPolicyLike} */
                this._streamTimeoutPolicy = /** @type {StreamTimeoutPolicyLike} */ (streamTimeoutPolicy);
        
        /** @type {ApiObserverLike} */
                this._apiObserver = /** @type {ApiObserverLike} */ (apiObserver);
        this._explicitSessionId = sessionId ?? this._explicitSessionId ?? null;
        this._sessionRunCtx = new RunContext({ sessionId: this._explicitSessionId ?? randomUUID() });
         // A backend sets this in its constructor; `step()` throws when it is
         // missing, so every read below happens after that guard.
         /** @type {StepAdapter} */
                  this._adapter = /** @type {any} */ (undefined);
         /** @type {Function|undefined} */
                  this._buildParameters = undefined;
         /** @type {Object|undefined} */
                  this._outputSchema = undefined;
        this._sessionRunCtx.emit({ emitter: eventEmitter, name: EVENTS.CLIENT.SESSION_START, payload: { provider, model, sessionId: this.sessionId } });
    }


    /**
     * Records this session's vendor calls into a cassette (`mode: 'record'`), or
     * answers them from it without calling the vendor (`mode: 'replay'`) — an
     * eval suite or a test then runs offline and deterministically. Tools still
     * run on replay; their side effects stay at-most-once through the journal.
     * @param {{cassette: import('../support/cassette.mjs').Cassette, mode: 'record'|'replay'}} arg0
     * @returns {this}
     */
    withCassette({ cassette, mode }) {
        if (!cassette || typeof cassette.wrap !== 'function') {
            throw new ConfigurationError({ message: 'withCassette requires a cassette from createCassette().', options: { option: 'cassette' } });
        }
        this._adapter = /** @type {StepAdapter} */ (/** @type {unknown} */ (cassette.wrap({ adapter: /** @type {any} */ (this._adapter), mode })));
        return this;
    }

    
    /**
     * the vendor request (with retry/timeout wrapping), consumes the stream
     * and yields unified events (text, thought, tool_calls, tool_request,
     * quota, ...). The final state is `{ done, content, messages,
     * thoughtSignature, ... }`; it carries `unhandledToolCalls: true` when a
     * tool round was never answered (the yield was consumed without
     * next(toolResults)).
     * @param {{messages: Array<ChatRow>, options?: StepOptions}} arg0 - Conversation history.
     *   run's token budget. Clamps (never raises) the session's `max_tokens`.
     * @returns {AsyncGenerator<StepEvent, StepFinalState, Array<Object>|null|undefined>} unified step events; return value is the final state.
     */
        async* step({ messages, options = {} }) {
        if (!this._adapter) {
            throw new AbstractMethodError({ message: 'AbstractChatSession.step: no _adapter set. ' +
                'Each backend must set this._adapter in its constructor.' });
        }
        const stepRun = RunContext.child(options?.runContext ?? this._sessionRunCtx);
        stepRun.emit({ emitter: this.eventEmitter, name: EVENTS.CLIENT.SESSION_STEP_START, payload: { messageCount: messages?.length ?? 0 } });
        const { forceTextResponse = false, toolChoiceRequired = false, thoughtSignature = null, isLastIteration = false, signal } = options;

        const stepCtx = this._onStepWillStart
            ? this._onStepWillStart({ messages, options })
            : { messages, options };
        const ctxMessages = stepCtx?.messages ?? messages;
        const ctxOptions = stepCtx?.options ?? options;
        const effectiveForceText = ctxOptions.forceTextResponse ?? forceTextResponse;
        const effectiveToolChoice = ctxOptions.toolChoiceRequired ?? toolChoiceRequired;
        const effectiveSig = ctxOptions.thoughtSignature ?? thoughtSignature;

        const effectiveIsLast = ctxOptions.isLastIteration !== undefined ? !!ctxOptions.isLastIteration : isLastIteration;
        const shouldPrepare = this._onStepShouldPrepare ? this._onStepShouldPrepare() !== false : true;
        const preparedMessages = shouldPrepare
            ? await this._prepareStepMessages({ messages: ctxMessages, options: { signal, isLastIteration: effectiveIsLast, runContext: stepRun } })
            : ctxMessages;
        // A hook that skips preparation leaves the anchor from the previous step;
        // the adapter would then scan for a block this request does not carry and
        // mark nothing (or, worse, an unrelated duplicate).
        if (!shouldPrepare) this._cacheAnchor = null;

        const buildCtx = this._onStepBuildContext
            ? this._onStepBuildContext({ forceTextResponse: effectiveForceText, toolChoiceRequired: effectiveToolChoice })
            : { session: this };

        const stepController = new AbortController();
        const abortStepFromExternal = () => stepController.abort(signal?.reason ?? new Error('Aborted'));
        if (signal) {
            if (signal.aborted) stepController.abort(signal.reason);
            else signal.addEventListener('abort', abortStepFromExternal, { once: true });
        }
        const totalTimeoutMs = Number(this._totalTimeoutMs) > 0 ? Number(this._totalTimeoutMs) : LIMITS.max_elapsed_ms;
        
        /** @type {ReturnType<typeof setTimeout>|null} */
                let totalTimeoutId = null;
        if (totalTimeoutMs > 0) {
            totalTimeoutId = setTimeout(() => {
                const err =  (
                    new Error(`Step exceeded its total timeout (${totalTimeoutMs}ms)`)
                );
                err.name = 'TimeoutError';
                /** @type {any} */ (err).code = 'STEP_TIMEOUT';
                /** @type {any} */ (err).nonRetryable = true;
                stepController.abort(err);
            }, totalTimeoutMs);
        }
        const requestSignal = stepController.signal;
        /**
         * A request phase that ignores its signal must not wedge the step: the
         * losing promise is abandoned, the same contract as the tool round. The
         * abort's own reason is rethrown, so `STEP_TIMEOUT` keeps its identity.
         * @template T
         * @param {T|Promise<T>} result
         * @returns {Promise<T>}
         */
        const raceStep = async (result) => {
            try {
                return await raceWithAbort({ promise: Promise.resolve(result), signal: requestSignal });
            } catch (error) {
                throw requestSignal.aborted ? requestSignal.reason : error;
            }
        };
        const disposeStepSignal = () => {
            if (signal) signal.removeEventListener('abort', abortStepFromExternal);
            if (totalTimeoutId !== null) { clearTimeout(totalTimeoutId); totalTimeoutId = null; }
        };

        try {
        const maxOut = typeof ctxOptions.maxOutputTokens === 'number' && Number.isFinite(ctxOptions.maxOutputTokens) && ctxOptions.maxOutputTokens > 0
            ? ctxOptions.maxOutputTokens
            : null;
        const baseParameters = (maxOut !== null)
            ? {
                ...this._parameters,
                max_tokens: Math.min(
                    (Number.isFinite(Number(this._parameters?.max_tokens)) && Number(this._parameters?.max_tokens) > 0)
                        ? Number(this._parameters?.max_tokens)
                        : Infinity,
                    maxOut
                )
            }
            : this._parameters;
        // 4.2 — hand the adapter the last cached-prefix block. The cache knobs are
        // session policy, not vendor parameters: only the Anthropic adapter has a
        // wire slot for them, and putting them in `_parameters` leaked
        // `_cachePoints` into OpenAI/Gemini/JAI request bodies.
        const promptCache = this._promptCache && this.provider === ProviderType.ANTHROPIC ? this._promptCache : null;
        // SP6: the split system spends one breakpoint on the role template. The
        // vendor caps the total (4), so the message anchors get one fewer.
        // A slot is only spent when a MARKED block is actually emitted: the
        // stable block exists when there is a cacheable user block OR the SDK
        // descriptor (which joins the stable text). An all-volatile list with no
        // descriptor emits nothing marked, so it must not spend a slot.
        const splitBlocks = Array.isArray(/** @type {any} */ (this)._userSystemBlocks)
            ? /** @type {Array<{text: string, cache?: boolean}>} */ (/** @type {any} */ (this)._userSystemBlocks)
            : null;
        const systemMarked = Boolean(promptCache && splitBlocks?.length
            && (Boolean(this.getSystemMessage()) || splitBlocks.some((b) => b.cache !== false)));
        const messagePoints = promptCache ? Math.max(0, promptCache.points - (systemMarked ? 1 : 0)) : 0;
        const stepParameters = (promptCache && this._cacheAnchor && messagePoints > 0)
            ? {
                ...baseParameters,
                _cachePoints: messagePoints,
                _cachePointType: promptCache.type,
                ...(promptCache.ttl ? { _cachePointTtl: promptCache.ttl } : {}),
                _cacheAnchor: this._cacheAnchor,
            }
            : baseParameters;
        const vendorRequest = this._adapter.buildVendorRequest({
            model: this.model,
            parameters: stepParameters,
            tools: this._requestTools(),
            preparedMessages,
            forceTextResponse: effectiveForceText,
            toolChoiceRequired: effectiveToolChoice,
            thoughtSignature: effectiveSig,
            isLastIteration: effectiveIsLast,
            signal: requestSignal,
            session: buildCtx.session ?? this,
            runContext: stepRun,
        });

        if (this._hooks) {
            const originalRequest = vendorRequest.request;
            const transformed = await this._hooks.runWaterfall({ name: HOOKS.REQUEST_BEFORE, value: originalRequest, ctx: { session: this, runContext: stepRun, observability: vendorRequest.observability } });
            if (transformed !== STOP && transformed !== undefined) vendorRequest.request = transformed;
            // Observability: a hook may silently transform or veto the vendor
            // request; record that the chain ran and what it did (bodies stay on
            // the api_request event, never here).
            if (this._hooks.has({ name: HOOKS.REQUEST_BEFORE })) {
                emitEvent({ emitter: this.eventEmitter, name: EVENTS.HOOKS.REQUEST_BEFORE, payload: {
                    changed: transformed !== STOP && transformed !== originalRequest,
                    vetoed: transformed === STOP,
                    hooks: this._hooks.count({ name: HOOKS.REQUEST_BEFORE }),
                }, runContext: stepRun });
            }
            if (transformed === STOP) {
                const vetoResult = {
                    done: true,
                    content: '',
                    messages: [...messages],
                    thoughtSignature: effectiveSig,
                    vetoed: true,
                };
                this._lastStepMessages = vetoResult.messages;
                const stepEndVeto = this._onStepComplete ? this._onStepComplete({ result: vetoResult }) : vetoResult;
                stepRun.emit({ emitter: this.eventEmitter, name: EVENTS.CLIENT.SESSION_STEP_END, payload: {
                    done: true,
                    toolCalls: 0,
                    truncated: false,
                    contentLength: 0,
                    vetoed: true,
                } });
                return stepEndVeto;
            }
        }

        const requestStartTs = Date.now();
        this._apiObserver.onRequest({ meta: { ...vendorRequest.observability, provider: this.provider }, runContext: stepRun });

        // A test may null the policy to disable retries; narrowing through a local
        // keeps the call site honest instead of casting.
        const retryPolicy = this._retryPolicy;
        const vendorName = this._adapter.vendorName;
        let opened;
        
        /** @type {any} */
                let rest;
        try {
            if (vendorName !== 'JAI') {
                opened = await this._openFirstEvent({ operation: async () => {
                    if (stepController.signal.aborted) {
                        const err = new Error(`Stream aborted unexpectedly: ${stepController.signal.reason?.message ?? 'step aborted'}`);
                         /** @type {any} */
                                                  (err).nonRetryable = true;
                        throw err;
                    }
                    const raw = await raceStep(this._adapter.executeVendorRequest({ vendorClient: this.getVendorClient(), request: vendorRequest.request, signal: requestSignal, session: this }));
                    const stream = this._streamTimeoutPolicy?.wrapStream
                        /** @param {{err: *}} arg0 */
                        ? this._streamTimeoutPolicy.wrapStream({ stream: raw, signal: requestSignal, onTimeoutAbort: /** @type {(...args: any[]) => any} */ (({ err }) => {
                            if (err) err.nonRetryable = true;
                            stepController.abort(err);
                        }) })
                        : raw;
                    rest = this._adapter.consumeStream({ rawStream: stream, signal: requestSignal });
                    const first = await raceStep(rest.next());
                    const retryErr = firstEventRetryError({ first });
                    if (retryErr) {
                        if (rest.return) await rest.return(undefined).catch(() => {});
                        throw retryErr;
                    }
                    return first;
                }, ctx: { signal, vendorName, runContext: stepRun }, policy: retryPolicy });
            } else {
                opened = await this._openFirstEvent({ operation: async () => {
                    const raw = await raceStep(this._adapter.executeVendorRequest({ vendorClient: this.getVendorClient(), request: vendorRequest.request, signal: requestSignal, session: this }));
                    rest = this._adapter.consumeStream({ rawStream: raw, signal: requestSignal });
                    const first = await raceStep(rest.next());
                    const retryErr = firstEventRetryError({ first });
                    if (retryErr) {
                        if (rest.return) await rest.return(undefined).catch(() => {});
                        throw retryErr;
                    }
                    return first;
                }, ctx: { signal, vendorName, runContext: stepRun }, policy: retryPolicy });
            }
            // The observer hears the call end when the stream does (below), with its usage.
            await this._fireRequestAfter({ vendorRequest, stepRun, durationMs: Date.now() - requestStartTs, ok: true });
        } catch (err) {
            const durationMs = Date.now() - requestStartTs;
            // A cancelled call still ends: the observer closes it instead of pairing it with the next one.
            if (signal?.aborted) {
                this._apiObserver.onResponse({ meta: { ok: false, aborted: true, durationMs }, runContext: stepRun });
                throw err;
            }
            await this._fireRequestAfter({ vendorRequest, stepRun, durationMs, ok: false, error: err });
            // One failure, one terminal signal: the error carries the status and duration. Like
            // the success path's (at the stream's end) it follows the request:after chain.
            this._apiObserver.onError({ meta: { error: err, status: getErrorStatus({ error: err }) || 500, ok: false, durationMs }, runContext: stepRun });
            throw isAbortError({ err, signal: null }) && !hasTimeoutCode({ error: /** @type {Error} */ (err) }) ? new Error(`Stream aborted unexpectedly: ${String((/** @type {any} */ (err))?.message ?? err)}`) : err;
        }

        let toolCalls = [];
        /** @type {Array<any>} */
        let citations = [];
        /** @type {Array<{title?: string, url?: string}>} */
        let sources = [];
        let assistantText = '';
        let reasoningContent = '';
        let responseThoughtSignature = null;
        let redactedThinking = [];
        
        /** @type {Array<any>} */
                let nativeItems = [];
        
        /** @type {Array<any>} */
                let nativeBlocks = [];
        let streamError = null;
        let streamTruncated = false;
        let streamFiltered = false;
        /** @type {'length'|'premature_end'|null} */
        let streamTruncatedBy = null;
        let unhandledToolCalls = false;

        const streamWithFirst = (async function* () {
            if (!opened.done) yield opened.value;
            yield* rest;
        })();
        const streamStartTs = Date.now();
        stepRun.emit({ emitter: this.eventEmitter, name: EVENTS.CLIENT.API_STREAM_START, payload: { model: this.model, provider: this.provider } });
        let streamStatus = 'success';
        /** @type {any} */
        let lastQuota = null;
        /** @type {unknown} */
        let streamFailure = null;
        let streamCompleted = false;
        try {
            for await (const event of streamWithFirst) {
                switch (event.type) {
                    case EVENTS.STEP.TEXT:
                        assistantText += event.content;
                        if (event.thoughtSignature) {
                            responseThoughtSignature = event.thoughtSignature;
                        }
                        yield event;
                        break;
                    case EVENTS.STEP.THOUGHT:
                        if (event.reasoning_content) reasoningContent += event.content ?? '';
                        yield event;
                        break;
                    case EVENTS.STEP.TOOL_CALLS:
                        toolCalls = event.calls;
                        break;
                    case 'quota':
                        lastQuota = event.data ?? lastQuota;
                        yield { type: EVENTS.STEP.QUOTA, data: event.data };
                        break;
                    case EVENTS.STEP.FIRST_TOKEN:
                        stepRun.emit({ emitter: this.eventEmitter, name: EVENTS.CLIENT.STREAM_FIRST_TOKEN, payload: {
                            provider: this.provider,
                            model: this.model,
                            latencyMs: event.latencyMs
                        } });
                        yield event;
                        break;
                    case EVENTS.STEP.THOUGHT_SIGNATURE:
                        responseThoughtSignature = event.signature;
                        yield event;
                        break;
                    case EVENTS.STEP.REDACTED_THINKING:
                        redactedThinking = event.blocks ?? [];
                        yield event;
                        break;
                    case EVENTS.STEP.TOOL_CALL_DELTA:
                        yield event;
                        break;
                    case EVENTS.STEP.REASONING_ITEM:
                        nativeItems.push(event.item);
                        yield event;
                        break;
                    case EVENTS.STEP.THINKING_BLOCKS:
                        nativeBlocks.push(...(event.blocks ?? []));
                        yield event;
                        break;
                    case EVENTS.STEP.THOUGHT_PARTS:
                        nativeBlocks.push(...(event.parts ?? []));
                        yield event;
                        break;
                    case EVENTS.STEP.CITATIONS:
                        citations.push(...(event.data?.citations ?? []));
                        yield event;
                        break;
                    case 'sources':
                        sources.push(...(event.data?.sources ?? []));
                        yield event;
                        break;
                    case EVENTS.STEP.FINISH:
                        if (event.reason === 'length') { streamTruncated = true; streamTruncatedBy = 'length'; }
                        yield event;
                        break;
                    case EVENTS.STEP.PREMATURE_END:
                        streamTruncated = true;
                        streamTruncatedBy = 'premature_end';
                        streamFiltered = isContentFilterReason({ reason: event.reason });
                        yield event;
                        break;
                    case EVENTS.STEP.RESTART:
                        assistantText = '';
                        reasoningContent = '';
                        responseThoughtSignature = null;
                        redactedThinking = [];
                        nativeItems = [];
                        nativeBlocks = [];
                        toolCalls = [];
                        streamError = null;
                        streamTruncated = false;
                        streamFiltered = false;
                        streamTruncatedBy = null;
                        yield event;
                        break;
                    case EVENTS.STEP.UNKNOWN:
                        yield event;
                        break;
                    case EVENTS.CLIENT.ERROR:
                        streamError = event;
                        streamStatus = 'error';
                        yield event;
                        break;
                    case EVENTS.STEP.TRUNCATED:
                        streamTruncated = true;
                        break;
                }
            }
            streamCompleted = true;
        } catch (err) {
            streamStatus = 'error';
            if (signal?.aborted) throw err;
            streamFailure = err;
            throw isAbortError({ err, signal: null }) && !hasTimeoutCode({ error: /** @type {Error} */ (err) }) ? new Error(`Stream aborted unexpectedly: ${String((/** @type {any} */ (err))?.message ?? err)}`) : err;
        } finally {
            stepRun.emit({ emitter: this.eventEmitter, name: EVENTS.CLIENT.API_STREAM_END, payload: {
                model: this.model, provider: this.provider, durationMs: Date.now() - streamStartTs, status: streamStatus
            } });
            // The call's one terminal signal, when the response has fully arrived: success
            // (with the usage the stream reported), a failure, or a stop before the end
            // (an abort, or a consumer that returned early).
            const durationMs = Date.now() - requestStartTs;
            const usage = lastQuota ? { prompt_tokens: lastQuota.prompt_tokens, completion_tokens: lastQuota.completion_tokens } : null;
            if (streamFailure) this._apiObserver.onError({ meta: { error: /** @type {Error} */ (streamFailure), ok: false, durationMs }, runContext: stepRun });
            else if (streamCompleted) this._apiObserver.onResponse({ meta: { status: 200, ok: streamStatus === 'success', durationMs, ...(usage ? { usage } : {}) }, runContext: stepRun });
            else this._apiObserver.onResponse({ meta: { ok: false, aborted: true, durationMs }, runContext: stepRun });
        }

        if (streamTruncated) {
            toolCalls = [];
        } else if (toolCalls.length === 0) {
            toolCalls = this._recoverToolCallsFromText({ text: assistantText, extractFn: this._adapter.extractXmlToolCalls });
        }

        const finalSig = responseThoughtSignature;
        const nativePayload = nativeItems.length > 0
            ? { provider: this.provider, protocol: 'responses', items: nativeItems }
            : (nativeBlocks.length > 0 ? { provider: this.provider, protocol: this.protocol ?? null, items: nativeBlocks } : null);

        if (toolCalls.length > 0) {
            this._lastStepMessages = assistantText && String(assistantText).trim()
                ? [...messages, createAssistantMessage({ provider: /** @type {string} */ (this.provider), content: String(assistantText).trim(), thoughtSignature: finalSig, reasoningContent, redactedThinking })]
                : [...messages];
            yield { type: EVENTS.STEP.TOOL_CALLS, calls: toolCalls };
            stepRun.emit({ emitter: this.eventEmitter, name: EVENTS.CLIENT.TOOL_START, payload: { calls: toolCalls } });
            const results = yield { type: EVENTS.STEP.TOOL_REQUEST, calls: toolCalls, thoughtSignature: finalSig };
            if (!Array.isArray(results)) unhandledToolCalls = true;
            if (results && Array.isArray(results)) {
                stepRun.emit({ emitter: this.eventEmitter, name: EVENTS.CLIENT.TOOL_FINISH, payload: { results } });
            }

            const updatedMessages = this._formatFinalMessages({
                provider: this.provider,
                protocol: this.protocol ?? null,
                history: messages,
                text: assistantText,
                toolCalls,
                // `next(undefined)` is a legal no-tool-result resume; the formatter
                // wants null, not undefined.
                results: Array.isArray(results) ? results : null,
                thoughtSignature: finalSig,
                reasoningContent,
                redactedThinking,
                nativePayload,
                /** @param {{call: *, result: *, index: *}} arg0 */
                formatToolCall: ({ call, result, index }) => this._adapter.formatToolCall({ call, result, index }),
            });

            const result = {
                done: false,
                content: assistantText,
                messages: updatedMessages,
                thoughtSignature: finalSig,
                ...(unhandledToolCalls ? { unhandledToolCalls: true } : {}),
                ...(streamError ? { streamError } : {}),
                ...(streamTruncated ? { truncated: true } : {}),
                ...(streamTruncatedBy ? { truncatedBy: streamTruncatedBy } : {}),
                ...(streamFiltered ? { contentFiltered: true } : {})
            };
            this._lastStepMessages = updatedMessages;
            const stepEnd = this._onStepComplete ? this._onStepComplete({ result }) : result;
            stepRun.emit({ emitter: this.eventEmitter, name: EVENTS.CLIENT.SESSION_STEP_END, payload: {
                done: false,
                toolCalls: toolCalls.length,
                truncated: !!streamTruncated,
                contentLength: String(assistantText ?? '').length,
                ...(streamTruncatedBy ? { truncatedBy: streamTruncatedBy } : {}),
                ...(streamError ? { error: streamError.error_message ?? streamError.error_type ?? 'stream error' } : {})
            } });
            return stepEnd;
        }

        const updatedMessages = this._formatFinalMessages({
            provider: this.provider,
            protocol: this.protocol ?? null,
            history: messages,
            text: assistantText,
            toolCalls: [],
            results: null,
            thoughtSignature: finalSig,
            reasoningContent,
            redactedThinking,
            nativePayload,
            /** @param {{call: *, result: *, index: *}} arg0 */
            formatToolCall: ({ call, result, index }) => this._adapter.formatToolCall({ call, result, index }),
        });

        const result = {
            done: true,
            content: assistantText,
            messages: updatedMessages,
            thoughtSignature: finalSig,
            ...(streamError ? { streamError } : {}),
            ...(streamTruncated ? { truncated: true } : {}),
            ...(streamTruncatedBy ? { truncatedBy: streamTruncatedBy } : {}),
            ...(streamFiltered ? { contentFiltered: true } : {}),
            ...(citations.length ? { citations } : {}),
            ...(sources.length ? { sources } : {})
        };
        this._lastStepMessages = updatedMessages;
        const stepEndResult = this._onStepComplete ? this._onStepComplete({ result }) : result;
        stepRun.emit({ emitter: this.eventEmitter, name: EVENTS.CLIENT.SESSION_STEP_END, payload: {
            done: true,
            toolCalls: 0,
            truncated: !!streamTruncated,
            contentLength: String(assistantText ?? '').length,
            ...(streamTruncatedBy ? { truncatedBy: streamTruncatedBy } : {}),
            ...(streamError ? { error: streamError.error_message ?? streamError.error_type ?? 'stream error' } : {})
        } });
        return stepEndResult;
        } catch (stepError) {
            // A timeout is abort-shaped by design (the vendor request must be
            // destroyed), but it is not a user cancel: keep its telemetry.
            const timeoutCode = (() => {
                let cur = /** @type {any} */ (stepError);
                let depth = 0;
                while (cur && depth++ < LIMITS.cause_chain_depth) {
                    if (typeof cur.code === 'string' && TIMEOUT_CODES.has(cur.code)) return cur.code;
                    cur = cur.cause;
                }
                return null;
            })();
            if (!isAbortError({ err: stepError, signal: null }) || timeoutCode !== null) {
                const stepErrorCode = (/** @type {any} */ (stepError))?.code ?? null;
                if (timeoutCode === 'STEP_TIMEOUT') {
                    stepRun.emit({ emitter: this.eventEmitter, name: EVENTS.CLIENT.SESSION_STEP_TIMEOUT, payload: {
                        timeoutMs: totalTimeoutMs, message: String((/** @type {any} */ (stepError))?.message ?? stepError)
                    } });
                } else {
                    stepRun.emit({ emitter: this.eventEmitter, name: EVENTS.CLIENT.SESSION_STEP_ERROR, payload: {
                        name: (/** @type {any} */ (stepError))?.name ?? 'Error',
                        message: String((/** @type {any} */ (stepError))?.message ?? stepError),
                        code: timeoutCode ?? stepErrorCode
                    } });
                }
            }
            throw stepError;
        } finally {
            disposeStepSignal();
        }
    }

    
    /**
     * @param {{ messages: Array<ChatRow>, options: StepOptions }} param0
     * @returns {{ messages: Array<ChatRow>, options: StepOptions }}
     */
        _onStepWillStart({ messages, options }) {
        return { messages, options };
    }

    _onStepShouldPrepare() {
        return true;
    }

    /**
     * Fires the `request:after` hook chain once the vendor call has come back.
     *
     * The chain is **serial and observational**: it sees the request that was
     * sent, the round-trip duration and the error (if any), but it cannot
     * transform the response — the stream is already being consumed. A hook
     * that throws is reported and ignored: an observer must never break a run.
     *
     * @param {{ vendorRequest: VendorRequest, stepRun: RunContext, durationMs: number, ok: boolean, error?: unknown }} arg0 -
     * @returns {Promise<void>}
     */
        async _fireRequestAfter({ vendorRequest, stepRun, durationMs, ok, error = null }) {
        if (!this._hooks?.has({ name: HOOKS.REQUEST_AFTER })) return;
        try {
            await this._hooks.runSerial({
                name: HOOKS.REQUEST_AFTER,
                ctx: {
                    session: this,
                    runContext: stepRun,
                    observability: vendorRequest?.observability,
                    request: vendorRequest?.request,
                    response: { status: ok ? 200 : 500, ok, durationMs },
                    error
                }
            });
        } catch (err) {
            sdkWarn({ prefix: 'HOOKS', args: [`A request:after hook failed: ${(/** @type {any} */ (err))?.message ?? err}`] });
        }
        emitEvent({ emitter: this.eventEmitter, name: EVENTS.HOOKS.REQUEST_AFTER, payload: {
            hooks: this._hooks.count({ name: HOOKS.REQUEST_AFTER }),
            durationMs,
            ok
        }, runContext: stepRun });
    }

    
    /**
     * @param {{ forceTextResponse: boolean, toolChoiceRequired: boolean }} param0
     * @returns {{ session: AbstractChatSession }}
     */
        _onStepBuildContext({ forceTextResponse, toolChoiceRequired }) {
        return { session: this };
    }

    
    /**
     * @returns {StepFinalState}
      * @param {{result: StepFinalState}} arg0
     */
        _onStepComplete({ result }) {
        return result;
    }

    
    /**
     * Runs the objective restatement when the context's cadence says so.
     * Called by the agentic loop before each model call. No-ops unless
     * `withObjective(ctx, { adaptable: true })` (the default) put a policy on
     * the context. A rejected / unchanged restatement changes nothing.
     * @param {{ signal?: AbortSignal|null, messages?: Array<ChatRow>, runContext?: RunContext|null }} [options]
     * @returns {Promise<Object|null>} the pass outcome, or null when not due.
     */
        async _maybeObjectivePass({ signal = null, messages = [], runContext = null } = {}) {
        return runObjectivePass({ p: {
            ctx: this._agentContext,
            client: this.client,
            model: this.model,
            // G5: this pass fires mid-run (a session at its update cadence), so its
            // own session must announce a run-scoped id, not an auto uuid. The
            // suffix matters: the restatement is a DIFFERENT session from this one.
            sessionId: this.sessionId ? `${this.sessionId}:objective` : null,
            progress: objectiveProgressDigest({ messages }),
            approval: this._approvalPolicy,
            pool: /** @type {any} */ (this)._budgetPool ?? null,
            signal,
            /** @param {{outcome: *}} arg0 */
            emit: ({ outcome }) => this._emitObjectiveUpdate({ runContext, payload: outcome }),
            onUnavailable: () => {
                const warned =  (this);
                if (warned._objectivePassWarned !== true) {
                    warned._objectivePassWarned = true;
                    sdkWarn({ prefix: 'CHAT-SESSION', args: ['Objective restatement is enabled but this session has no client session factory; the objective stays at its initial value.'] });
                }
            },
        } });
    }

    
    /**
      * @param {{runContext?: RunContext|null, payload: Object}} arg0
     */
        _emitObjectiveUpdate({ runContext, payload }) {
        const p = /** @type {Record<string, Object>} */ (payload);
        const event = { ...p, turn: p.turn ?? this._agentContext?.objectiveTurn ?? 0 };
        if (runContext) runContext.emit({ emitter: this.eventEmitter, name: EVENTS.CLIENT.OBJECTIVE_UPDATED, payload: event });
        else this.eventEmitter?.emit(EVENTS.CLIENT.OBJECTIVE_UPDATED, event);
    }

    
    /**
      * @param {{messages: Array<ChatRow>, options?: StepOptions}} arg0
     */
        async _prepareStepMessages({ messages, options = {} }) {
        const { signal, isLastIteration = false, runContext = null } = options || {};
        throwIfAborted({ signal, message: 'Step aborted before preparation.' });

        let prepared = [...messages];
        let contextParts = [];
        // Wave 4 (4.1): the live-state blocks are the ones that change between
        // iterations (a `manage_todos` write, a memory query keyed on the last
        // user text). They must NOT sit in the cached prefix, so they become a
        // trailing row AFTER the breakpoint instead of part of `system[0]`.
        /** @type {Array<string>} */
        let volatileParts = [];

        const _ob = objectiveBlock({ ctx: this._agentContext, label: 'Global Objective' });
        // SP6: the host system may be a BLOCK list; the objective is already
        // visible if any of its texts carries the tag (reading only the string
        // field appended the objective twice for every block-based spawn).
        const ownSystemText = Array.isArray(/** @type {any} */ (this)._userSystemBlocks)
            ? /** @type {Array<{text: string}>} */ (/** @type {any} */ (this)._userSystemBlocks)
                .map((b) => String(b?.text ?? '')).join(SYSTEM_MESSAGE_MERGE_SEPARATOR)
            : String(this._userSystemMessage ?? '');
        const objectiveAlreadyVisible = ownSystemText.includes(OBJECTIVE_TAG)
            || prepared.some((m) => !isSystemRow({ m }) && typeof m.content === 'string' && m.content.includes(OBJECTIVE_TAG));
        if (_ob && !objectiveAlreadyVisible) contextParts.push(_ob);

        if (isLastIteration) {
            // The synthetic reminder stays in the system row (F5 pinned that): as a
            // trailing user turn it competes with the tool result the model must
            // consume. The volatile LIVE-STATE row below does ride the tail — it is
            // real context, not a nudge — and W4/f5-wire pins that tool_use →
            // tool_result pairing survives. Cost: the cache is invalidated once, on
            // the last iteration (fix-plan §0.2: 4/6 reads).
            contextParts.push(FINAL_ITERATION_REMINDER);
        }

        for (const { component, preload, extra, errorLabel, rethrowAbort, volatile = false } of [
            { component: this._skillsLibrary, preload: this._skillsPreload, errorLabel: 'Skills listing failed', rethrowAbort: false },
            { component: this._todoComponent, preload: this._todoPreload, errorLabel: 'Todo list load failed', rethrowAbort: false, volatile: true },
            { component: this._memoryComponent, preload: this._memoryPreload, errorLabel: 'Memory block injection failed', rethrowAbort: true, volatile: true },
            // m18: the web blocks are preload-configurable like every other
            // capability. The default stays on (that is the documented behaviour);
            // `preload: false` keeps the tool and drops the block.
            { component: this._webSearchComponent, preload: this._webSearchPreload !== false, extra: { mode: this._webSearch?.mode }, errorLabel: 'Web search block failed', rethrowAbort: false },
            { component: this._webScrapeComponent, preload: this._webScrapePreload !== false, extra: { mode: this._webScrape?.mode }, errorLabel: 'Web scrape block failed', rethrowAbort: false },
            { component: this._browserComponent, preload: this._browserPreload !== false, extra: { mode: this._browser?.mode }, errorLabel: 'Browser block failed', rethrowAbort: false },
            ...(Array.isArray(this._extraStepComponents) ? this._extraStepComponents : []),
        ]) {
            if (!component) continue;
            try {
                const ctx = { messages: prepared, preload, runContext, ...(extra ?? {}) };
                if (await component.shouldInjectStep(ctx)) {
                    const block = await component.stepBlock(ctx);
                    if (block) (volatile ? volatileParts : contextParts).push(block);
                }
            } catch (err) {
                if (rethrowAbort && isAbortError({ err, signal })) throw err;
                sdkError({ prefix: 'CHAT-SESSION', args: [`${errorLabel}: ${String((/** @type {any} */ (err))?.message ?? err)}`] });
            }
        }

        if (this._agent === AGENT_PLAN && this._todoComponent) {
            contextParts.push(PLAN_MODE_REMINDER);
        } else if (this._planHandoff && this._todoComponent) {
            contextParts.push(BUILD_SWITCH_REMINDER.replace('${planPath}', this._todoComponent._filePath ?? 'your plan'));
            // The switch is a one-time orientation note; injecting it on every
            // step of the execution run is noise.
            this._planHandoff = false;
        }

        if (this._autoContext) {
            if (this._autoContext.env) {
                try {
                    const env = await buildEnvironmentBlock({ root: this._autoContext.root });
                    if (env) contextParts.push(env);
                } catch (err) {
                    sdkError({ prefix: 'CHAT-SESSION', args: [`Environment block failed: ${String((/** @type {any} */ (err))?.message ?? err)}`] });
                }
            }
            if (this._autoContext.instructions) {
                try {
                    const instructions = await discoverInstructions({
                        root: this._autoContext.root,
                        stopAt: this._autoContext.stopAt,
                        eventEmitter: this.eventEmitter ?? null,
                    });
                    if (instructions) contextParts.push(instructions);
                } catch (err) {
                    sdkError({ prefix: 'CHAT-SESSION', args: [`Instructions discovery failed: ${String((/** @type {any} */ (err))?.message ?? err)}`] });
                }
            }
        }

        if (this._outputSchema) {
            contextParts.push(
                '[Output Schema]\nReturn data conforming EXACTLY to this JSON Schema. Field names, required keys, and enum values are CASE-SENSITIVE — copy them verbatim:\n' +
                JSON.stringify(this._outputSchema, null, 2)
            );
        }

        if (this._contextProcessors?.length) {
            const ordered = [...this._contextProcessors].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            for (const p of ordered) {
                try {
                    const out = /** @type {any} */ (await p.process({ session: this, messages: prepared, contextParts }));
                    if (out) {
                        if (Array.isArray(out.contextParts)) contextParts = out.contextParts;
                        if (Array.isArray(out.messages)) prepared = out.messages;
                    }
                    emitEvent({ emitter: this.eventEmitter, name: EVENTS.CONTEXT.PROCESSOR_APPLIED, payload: {
                        name: p.name ?? null, order: p.order ?? 0, messages: prepared.length, contextParts: contextParts.length
                    }, runContext });
                } catch (error) {
                    emitEvent({ emitter: this.eventEmitter, name: EVENTS.CONTEXT.PROCESSOR_ERROR, payload: {
                        name: p.name ?? null, order: p.order ?? 0, error: (/** @type {any} */ (error))?.message ?? String(error)
                    }, runContext });
                    throw error;
                }
            }
        }

        const summary = prepared.find((m) => isSystemRow({ m }) && typeof m.content === 'string' && m.content.includes(CONVERSATION_SUMMARY_MARKER));
        const summaryText = summary ? summary.content : null;
        // SP6: a role template is the cacheable prefix; the per-spawn adaptation
        // and the run's context parts are not. Only Anthropic has a wire slot for
        // a per-block marker, and only when the host opted into caching — every
        // other backend keeps the single merged string it always got.
        const structured = Array.isArray(/** @type {any} */ (this)._userSystemBlocks)
            ? /** @type {Array<{text: string, cache?: boolean}>} */ (/** @type {any} */ (this)._userSystemBlocks)
            : null;
        const policy = structured && this.provider === ProviderType.ANTHROPIC ? (/** @type {any} */ (this)._promptCache ?? null) : null;
        /** @type {any} */
        let sysContent;
        if (policy && structured?.length) {
            const stableParts = [this.getSystemMessage(), ...structured.filter((b) => b.cache !== false).map((b) => b.text)];
            const volatilePartsSystem = [...structured.filter((b) => b.cache === false).map((b) => b.text), ...contextParts, summaryText];
            const stable = stableParts.filter(Boolean).join(SYSTEM_MESSAGE_MERGE_SEPARATOR);
            const volatile = volatilePartsSystem.filter(Boolean).join(SYSTEM_MESSAGE_MERGE_SEPARATOR);
            sysContent = [
                ...(stable ? [{ type: 'text', text: stable, cache_control: { type: policy.type ?? 'ephemeral', ...(policy.ttl ? { ttl: policy.ttl } : {}) } }] : []),
                ...(volatile ? [{ type: 'text', text: volatile }] : []),
            ];
            if (sysContent.length === 0) sysContent = null;
        } else {
            const userSystem = structured?.length
                ? structured.map((b) => b.text).join(SYSTEM_MESSAGE_MERGE_SEPARATOR)
                : (this._userSystemMessage || null);
            const base = [this.getSystemMessage(), userSystem, contextParts.join(SYSTEM_MESSAGE_MERGE_SEPARATOR)]
                .filter(Boolean).join(SYSTEM_MESSAGE_MERGE_SEPARATOR);
            // A summary is folded into OUR system row only when we own one; with
            // no system of our own the history's system rows pass through as they
            // are (merging them would drop one).
            sysContent = base ? (summaryText ? base + SYSTEM_MESSAGE_MERGE_SEPARATOR + summaryText : base) : null;
        }

        if (sysContent) {
            prepared = prepared.filter((m) => !isSystemRow({ m }));
            const hasUser = prepared.some((m) => isUserRow({ m }));
            prepared.unshift(hasUser
                ? { type: 'system_message', content: sysContent }
                : { type: 'user_message', content: sysContent });
        }

        throwIfAborted({ signal, message: 'Step aborted after context assembly.' });

        // 4.1 — the volatile block rides a trailing row, so the cached prefix
        // (tools → system → history) is identical between iterations. It is added
        // AFTER the system merge on purpose: anything in `system` is cached prefix.
        // On a tool round this row follows the tool result; that is deliberate (the
        // live state must be the last thing the model sees) and W4/f5-wire pins
        // that the wire keeps tool_use → tool_result pairing.
        if (volatileParts.length > 0) {
            prepared.push(createUserMessage({ provider: this.provider, content: volatileParts.join(SYSTEM_MESSAGE_MERGE_SEPARATOR) }));
        }

        const normalized = this._normalizeMessageSequence({ messages: prepared });
        // 4.2 — the anchor is the last row that belongs to the cached prefix. The
        // adapter cannot take an index: its own normalizer merges consecutive
        // same-role rows, so the stable tail can end up as one block inside a
        // merged message. A block descriptor survives the merge.
        const systemRows = normalized.filter((m) => isSystemRow({ m })).length;
        const stableRows = volatileParts.length > 0 ? normalized.length - 1 : normalized.length;
        const nonSystem = normalized.filter((m) => !isSystemRow({ m }));
        const anchorRow = nonSystem[Math.max(0, stableRows - systemRows) - 1] ?? null;
        this._cacheAnchor = anchorRow ? lastBlockAnchor(anchorRow) : null;
        return normalized;
    }

    
    /**
     * @returns {Array<ChatRow>}
      * @param {{messages: Array<ChatRow>}} arg0
     */
        _normalizeMessageSequence({ messages }) {
        if (!Array.isArray(messages) || messages.length === 0) {
            return [createUserMessage({ provider: this.provider, content: 'Continue.' })];
        }
        const out = [];
        let lastRole = null;
        let hasUser = false;
        for (const m of messages) {
            if (!String(m.content ?? '').trim()
                && (m.type === 'assistant_message_text'
                    || (m.role === 'assistant' && typeof m.content === 'string' && !Array.isArray(m.tool_calls)))) {
                continue;
            }
            const role = m.role === 'user' || m.type === 'user_message' ? 'user'
                : m.role === 'assistant' || m.type === 'assistant_message_text' || m.type === 'assistant_message_tool' ? 'assistant'
                : null;
            if (m.type === 'tool_message') { lastRole = null; out.push(m); continue; }
            if (role === 'user') hasUser = true;
            if (role && role === lastRole) {
                
                /** @type {ChatRow} */
                                const prev = out[out.length - 1];
                const bothText = role === 'user'
                    ? prev.type === 'user_message' && m.type === 'user_message'
                    : prev.type === 'assistant_message_text' && m.type === 'assistant_message_text';
                if (bothText) {
                    
                    /** @type {ChatRow} */
                                        const merged = { ...prev, content: String(prev.content ?? '') + '\n\n' + String(m.content ?? '') };
                    if (m.thoughtSignature || m.thought_signature) {
                        delete merged.thought_signature;
                        merged.thoughtSignature = m.thoughtSignature ?? m.thought_signature;
                    }
                    if (m.reasoning_content) {
                        merged.reasoning_content = String(merged.reasoning_content ?? '')
                            ? String(merged.reasoning_content) + '\n\n' + String(m.reasoning_content)
                            : m.reasoning_content;
                    }
                    const dynM = /** @type {Record<string, Object>} */ (m);
                    const dynMerged = /** @type {Record<string, Object>} */ (merged);
                    if (dynM[INJECTION_META_KEY]) dynMerged[INJECTION_META_KEY] = dynM[INJECTION_META_KEY];
                    if (dynM[MERCI_NATIVE_KEY]) {
                        const dynPrev = /** @type {Record<string, Object>} */ (prev);
                        const prevNative = /** @type {any} */ (dynPrev[MERCI_NATIVE_KEY]);
                        const nextNative = /** @type {any} */ (dynM[MERCI_NATIVE_KEY]);
                        dynMerged[MERCI_NATIVE_KEY] = prevNative
                            ? { ...nextNative, items: [...(prevNative.items ?? []), ...(nextNative.items ?? [])] }
                            : nextNative;
                    }
                    out[out.length - 1] = merged;
                    continue;
                }
            }
            out.push(m);
            if (role) lastRole = role;
        }
        if (!hasUser) {
            out.push(createUserMessage({ provider: this.provider, content: 'Continue.' }));
        }
        return out;
    }

    
    /**
     * @returns {Array<Object>}
      * @param {{text: string|null|undefined, extractFn: Function|null|undefined}} arg0
     */
        _recoverToolCallsFromText({ text, extractFn }) {
        if (!text || !text.includes(XML_TOOL_CALL_TAGS.START)) return [];
        if (typeof extractFn !== 'function') return [];
        return extractFn({ text });
    }

    
    /**
     * @returns {Promise<FirstEventResult>}
      * @param {{operation: Function, ctx: StepCallContext, policy: RetryPolicyLike|null}} arg0
     */
        async _openFirstEvent({ operation, ctx, policy }) {
        try {
            return /** @type {FirstEventResult} */ (await this._runWithRetry({ operation, ctx, policy }));
        } catch (err) {
            const e =  (err);
            if (e && /** @type {any} */ (e).streamEvent) {
                return { done: false, value: /** @type {any} */ (e).streamEvent };
            }
            throw err;
        }
    }

    
    /**
      * @param {{operation: Function, ctx?: StepCallContext, policy?: RetryPolicyLike|null}} arg0
      * @returns {Promise<Object>}
     */
        async _runWithRetry({ operation, ctx = {}, policy = this._retryPolicy }) {
        const observer = this._apiObserver;
        let retries = 0;
        return runGuardedStep({
            breaker: this._circuitBreaker ?? null,
            signal: ctx.signal ?? null,
            run: () => runWithRetry({ operation: /** @type {any} */ (operation), policy: /** @type {any} */ (policy), signal: ctx.signal || null, maxElapsedMs: ctx.maxElapsedMs ?? this._maxElapsedMs ?? LIMITS.max_elapsed_ms, vendorName: ctx.vendorName || null, onRetry: /** @type {(...args: any[]) => any} */ ((meta) => {
                    retries++;
                    if (observer && typeof observer.onRetry === 'function') observer.onRetry({ meta, runContext: ctx.runContext ?? null });
                }) }),
            onBreakerOpen: () => {
                const err = new Error(`Circuit breaker open for ${ctx.vendorName ?? 'backend'} — skipping a doomed attempt; use a fallback model or wait out the cooldown.`);
                 /** @type {any} */
                                  (err).code = BREAKER_OPEN_CODE;
                 /** @type {any} */
                                  (err).nonRetryable = true;
                throw err;
            },
            /** @param {{err: *}} arg0 */
            onFailure: ({ err }) => {
                /** @type {any} */
                                if (retries > 0 && err && ! (err).nonRetryable)  (err).nonRetryable = true;
                throw err;
            },
        });
    }

    
    /**
 * @param {{provider?: string, history: Array<ChatRow>, text: string, toolCalls: Array<Object>, results: Array<ToolResult>|null, thoughtSignature: string|null, reasoningContent: string, redactedThinking?: Array<string>, nativePayload: NativePayload|null, formatToolCall: Function, protocol?: string|null}} arg0
 * @returns {Array<ChatRow>}
 */
        _formatFinalMessages({ provider, history, text, toolCalls, results, thoughtSignature, reasoningContent, redactedThinking, nativePayload, formatToolCall, protocol = null }) {
        const updated = [...history];
        if (!toolCalls || toolCalls.length === 0) {
            if (text && String(text).trim()) {
                const row = createAssistantMessage({ provider: /** @type {string} */ (provider), content: String(text).trim(), thoughtSignature, reasoningContent, redactedThinking });
                if (nativePayload) attachNative({ row, provider: nativePayload.provider, protocol: nativePayload.protocol, items: nativePayload.items });
                updated.push(row);
            }
            return updated;
        }
        const resultByCallId = new Map();
        if (Array.isArray(results)) {
            for (const r of results) {
                if (!r) continue;
                const rid = r.tool_call_id ?? r.id;
                if (rid) resultByCallId.set(rid, r);
            }
        }
        /** @param {{call: *, idx: *}} arg0 */
        const resultFor = ({ call, idx }) => {
            const callId = call.id ?? call.tool_call_id;
            if (callId && resultByCallId.has(callId)) return resultByCallId.get(callId);
            if (Array.isArray(results) && results[idx]) return results[idx];
            return {
                id: callId,
                tool_call_id: callId,
                name: call.name || call.function?.name || '',
                success: false,
                error: 'Tool call produced no result (the caller returned no result for this call).'
            };
        };
        const merge = !isStandard({ provider: /** @type {string} */ (provider), standard: StandardType.GAI }) && provider !== ProviderType.JAI;
        if (merge) {
            const descriptors = [];
            for (let i = 0; i < toolCalls.length; i++) {
                const call = toolCalls[i];
                if (!call) continue;
                descriptors.push(formatToolCall({ call, result: resultFor({ call, idx: i }), index: i }));
            }
            const combined = createAssistantMessage({ provider: /** @type {string} */ (provider), content: (text || '').trim(), thoughtSignature, reasoningContent, redactedThinking });
            if (nativePayload) attachNative({ row: combined, provider: nativePayload.provider, protocol: nativePayload.protocol, items: nativePayload.items });
             /** @type {Record<string, any>} */
                          (combined).tool_calls = descriptors.map(( d) => ({
                id: d.id, type: 'function', function: { name: d.name, arguments: d.args }
            }));
            updated.push(combined);
            for (let i = 0; i < toolCalls.length; i++) {
                const call = toolCalls[i];
                if (!call) continue;
                updated.push(createToolResultMessage({ provider: /** @type {string} */ (provider), result: resultFor({ call, idx: i }), thoughtSignature, protocol }));
            }
        } else if (isStandard({ provider: /** @type {string} */ (provider), standard: StandardType.GAI })) {
            // Gemini returns parallel calls in one model turn, each with its own
            // signature; replaying them one row at a time breaks that turn. Only
            // the turn's first call may fall back to the response signature —
            // copying it onto every call sends a signature the vendor never issued.
            /** @type {Array<{id: string, name: string, args: string|Object, thoughtSignature?: string|null}>} */
            const calls = [];
            for (let i = 0; i < toolCalls.length; i++) {
                const call = toolCalls[i];
                if (!call) continue;
                const formatted = formatToolCall({ call, result: resultFor({ call, idx: i }), index: i });
                calls.push({
                    id: formatted.id,
                    name: formatted.name,
                    args: formatted.args,
                    thoughtSignature: calls.length === 0 ? (formatted.thoughtSignature ?? thoughtSignature) : formatted.thoughtSignature,
                });
            }
            let nativeAttached = false;
            if (text && text.trim()) {
                // Gemini validates a signature per part: a text part is not the
                // call, so the turn's fallback signature stays off it.
                const row = createAssistantMessage({ provider: /** @type {string} */ (provider), content: text.trim(), thoughtSignature: calls.length > 0 ? null : thoughtSignature, reasoningContent, redactedThinking });
                if (nativePayload) {
                    attachNative({ row, provider: nativePayload.provider, protocol: nativePayload.protocol, items: nativePayload.items });
                    nativeAttached = true;
                }
                updated.push(row);
            }
            const toolRow = createToolCallMessage({ provider: /** @type {string} */ (provider), calls });
            if (nativePayload && !nativeAttached) {
                attachNative({ row: toolRow, provider: nativePayload.provider, protocol: nativePayload.protocol, items: nativePayload.items });
            }
            updated.push(toolRow);
            for (let i = 0; i < toolCalls.length; i++) {
                const call = toolCalls[i];
                if (!call) continue;
                updated.push(createToolResultMessage({ provider: /** @type {string} */ (provider), result: resultFor({ call, idx: i }), thoughtSignature, protocol }));
            }
        } else {
            let nativeAttached = false;
            if (text && text.trim()) {
                const row = createAssistantMessage({ provider: /** @type {string} */ (provider), content: text.trim(), thoughtSignature, reasoningContent, redactedThinking });
                if (nativePayload) {
                    attachNative({ row, provider: nativePayload.provider, protocol: nativePayload.protocol, items: nativePayload.items });
                    nativeAttached = true;
                }
                updated.push(row);
            }
            for (let i = 0; i < toolCalls.length; i++) {
                const call = toolCalls[i];
                if (!call) continue;
                const { id, name, args, thoughtSignature: perCallSig } = formatToolCall({ call, result: resultFor({ call, idx: i }), index: i });
                const toolRow = createToolCallMessage({ provider: /** @type {string} */ (provider), id, name, args, thoughtSignature: perCallSig ?? thoughtSignature });
                if (nativePayload && !nativeAttached) {
                    attachNative({ row: toolRow, provider: nativePayload.provider, protocol: nativePayload.protocol, items: nativePayload.items });
                    nativeAttached = true;
                }
                updated.push(toolRow);
                updated.push(createToolResultMessage({ provider: /** @type {string} */ (provider), result: resultFor({ call, idx: i }), thoughtSignature, protocol }));
            }
        }
        return updated;
    }
}


/**
 * Shared OAI-family ChatSession (oai/gai/aai). They differ only in the
 * backend type, adapter, parameter translator and builder backend — everything
 * else lives in AbstractChatSession.
 * @extends {AbstractChatSession}
 */
export class BaseChatSession extends AbstractChatSession {
    
    /**
     * (`{ vendorClient, model, eventEmitter, provider, builderStandard?, adapter, buildParameters }`).
     * @param {{vendorClient: Object|null, model: string, eventEmitter: import('node:events').EventEmitter|null|undefined, provider?: string, builderStandard?: string, adapter?: StepAdapter, buildParameters?: Function, sessionId?: string|null}} arg0 - The vendor client, or the options object.
         */
        constructor({ vendorClient, model, eventEmitter, provider, builderStandard, adapter, buildParameters, sessionId = null }) {
        super({ provider, model, eventEmitter: eventEmitter ?? null, client: /** @type {any} */ (eventEmitter), vendorClient, builderStandard, sessionId });
        this.standard = builderStandard ?? standardFor({ provider }) ?? '';
        this._adapter = /** @type {StepAdapter} */ (adapter);
        this._buildParameters = buildParameters;
    }

    
    /**
     * the json_schema output schema for client-side validation, and downgrades
     * json_schema to json_object on the OPENCODE backend (its gateway rejects
     * the former with a 400).
     * @param {{params: Function|Object}} arg0 -
     * @returns {this}
     */
        withParameters({ params }) {
        if (typeof params === 'function') {
            const builder = new UnifiedParameterBuilder({ model: this.model, eventEmitter: this.eventEmitter, provider: this.provider, standard: this.standard });
            const spec = params(builder).build();
            const rf = spec.responseFormat;
            if (rf?.type === 'json_schema' && rf.json_schema) {
                this._outputSchema = rf.json_schema.schema ?? rf.json_schema;
            }
            this._parameters = { ...this._parameters, ...(/** @type {Function} */ (this._buildParameters))({ spec }) };
        } else if (params && typeof params === 'object') {
            warnRefusedSpecKeys({ standard: this.standard, spec: /** @type {Record<string, unknown>} */ (params), eventEmitter: this.eventEmitter, model: this.model, provider: this.provider });
            this._parameters = { ...this._parameters, ...(/** @type {Function} */ (this._buildParameters))({ spec: params }) };
            const rf = /** @type {{type?: string, json_schema?: {schema?: Object}}|undefined} */ (this._parameters?.response_format);
            if (rf?.type === 'json_schema' && rf.json_schema) {
                this._outputSchema = rf.json_schema.schema ?? rf.json_schema;
            }
        }
        if (this.provider === ProviderType.OPENCODE && /** @type {{type?: string}|undefined} */ (this._parameters?.response_format)?.type === 'json_schema') {
            (/** @type {Record<string, Object|null>} */ (this._parameters)).response_format = { type: 'json_object' };
        }
        emitEvent({ emitter: this.eventEmitter, name: EVENTS.CLIENT.SESSION_PARAMS_APPLIED, payload: {
            model: this.model ?? null, provider: this.provider ?? null, keys: Object.keys(this._parameters ?? {})
        } });
        return this;
    }
}
