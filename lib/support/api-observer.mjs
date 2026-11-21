// @ts-check


/**
 * @file Pluggable API-call observers.
 * @version 0.12.0
 *
 * @description
 * An `ApiObserver` receives lifecycle notifications for every vendor SDK
 * call: a request is sent, a response is received, or an error is thrown.
 * The default `EventEmitterApiObserver` maps these to the existing
 * `api_request` / `api_response` / `error` events on the session's
 * `EventEmitter`, preserving the current observable behavior of all four
 * backends.
 *
 * Power users can swap the default by injecting a custom observer (e.g. to
 * forward API calls to an OpenTelemetry exporter, a metrics backend, or a
 * test recorder) through `ChatSession` configuration. `CompositeApiObserver`
 * fans one notification out to several observers, so an extra observer can
 * run next to the default without dropping the `api_*` events.
 *
 * @example
 * import { EventEmitter } from 'events';
 * import { EventEmitterApiObserver } from './api-observer.mjs';
 * const emitter = new EventEmitter();
 * const observer = new EventEmitterApiObserver(emitter);
 * observer.onRequest({ url, method, body, headers });
 * emitter.on('api_request', meta => console.log('req', meta));
 */
import { EVENTS, emitEvent } from '../core/events.mjs';


/**
 * One vendor call's request snapshot.
 * @typedef {Object} ApiRequestMeta
 * @property {string} [url] - The request URL (JAI's transport uses this; SDK-method calls use `model`).
 * @property {string} [method] - HTTP method (JAI only).
 * @property {unknown} [body] - The request body (JAI) or the SDK-call params (OAI/AAI/GAI).
 * @property {Record<string, string>} [headers] - The request headers (JAI only).
 * @property {string} [model] - The model name (OAI/AAI/GAI).
 * @property {string} [provider] - The session's backend (`openai`, `anthropic`, …), set by the session.
 * @property {Array<Object>} [messages] - The messages array (OAI/AAI/GAI).
 * @property {Record<string, unknown>} [params] - The full SDK-call params object (OAI/AAI/GAI).
 * @property {Array<Object>} [contents] - The Google GenAI contents array (GAI).
 * @property {Record<string, unknown>} [config] - The Google GenAI config object (GAI).
 */

/**
 * One vendor call's response snapshot.
 * @typedef {Object} ApiResponseMeta
 * @property {string} [url] - The request URL (JAI only).
 * @property {number} [status] - HTTP status code (or 200 for SDK-method success).
 * @property {boolean} [ok] - Whether the response was successful.
 * @property {Record<string, string>} [headers] - The response headers (JAI only).
 * @property {number} [durationMs] - The request→response duration (computed when absent).
 * @property {boolean} [aborted] - The caller cancelled the call (`ok` is `false`).
 * @property {{prompt_tokens?: number, completion_tokens?: number}} [usage] - The tokens the response reported.
 */

/**
 * One vendor call's failure.
 * @typedef {Object} ApiErrorMeta
 * @property {Error} error - The thrown error.
 * @property {number} [status] - HTTP status of a failed call (absent for a mid-stream failure).
 * @property {boolean} [ok] - `false` when this is the call's terminal signal (no `onResponse` follows or preceded it).
 * @property {number} [durationMs] - The request→failure duration.
 */

/**
 * One retry of a vendor call.
 * @typedef {Object} ApiRetryMeta
 * @property {string|null} vendor
 * @property {number} attempt
 * @property {number} nextDelayMs
 * @property {Error} error
 */

/**
 * The observer contract. Every member is optional, so an implementor may cover
 * a subset and the composite skips the rest.
 * @typedef {Object} ApiObserver
 * @property {(arg0: {meta: ApiRequestMeta, runContext?: ObserverRunContext|null}) => void} [onRequest]
 *   Called immediately before the vendor SDK call (or fetch).
 * @property {(arg0: {meta: ApiResponseMeta, runContext?: ObserverRunContext|null}) => void} [onResponse]
 *   Called when the response has fully arrived (a streamed call: at the stream's end,
 *   with its usage), or with `aborted: true` when the call stopped before it.
 * @property {(arg0: {meta: ApiErrorMeta, runContext?: ObserverRunContext|null}) => void} [onError]
 *   Called when the vendor SDK call (or fetch) throws or returns a non-OK status.
 * @property {(arg0: {meta: ApiRetryMeta, runContext?: ObserverRunContext|null}) => void} [onRetry]
 *   Optional — called when the vendor call is retried.
 */

/**
 * The slice of a `RunContext` an observer uses: envelope a payload with the
 * correlation fields of the run.
 * @typedef {Object} ObserverRunContext
 * @property {(arg0: {name: string, payload?: Record<string, unknown>}) => Record<string, unknown>} wrap
 */

/**
 * The emitter an observer reports through. The map argument keeps the emitted
 * generic from defaulting to `any`.
 * @typedef {import('node:events').EventEmitter<Record<string, unknown[]>>} ObserverEmitter
 */












/**
 * The default ApiObserver: emits `api_request` and `api_response` on the
 * session's `EventEmitter` and re-throws / re-emits the error via the
 * `error` event. This preserves the exact observable behavior of the current
 * OAI/AAI/GAI/JAI step() code paths.
 *
 * @example
 * const observer = new EventEmitterApiObserver(session.eventEmitter);
 * observer.onRequest({ model: this.model, messages: allMessages, params });
 * // ... fetch ...
 * observer.onResponse({ status: 200, ok: true });
 */
export class EventEmitterApiObserver {
    
    /**
     * @param {{emitter: import('node:events').EventEmitter|null}} arg0 - The session's event emitter. When null, all calls are silent no-ops.
     */
        constructor({ emitter }) {
        /** @type {ObserverEmitter|null} */
        this._emitter = /** @type {ObserverEmitter|null} */ (emitter || null);
        /** @type {ObserverRunContext|null} */
        this._runContext = null;
        this._lastRequestTs = 0;
    }

    
    /**
     * context is not passed per call (direct observer users). Session-driven
     * emissions pass the per-step context explicitly — no shared state.
     * @param {{runContext: ObserverRunContext|null}} arg0 -
     */
        setRunContext({ runContext }) {
        this._runContext = runContext || null;
    }

    
    /**
      * @param {{meta: ApiRequestMeta, runContext?: ObserverRunContext|null}} arg0
     */
        onRequest({ meta, runContext }) {
        this._lastRequestTs = Date.now();
        if (this._emitter && typeof this._emitter.emit === 'function') {
            try {
                this._emitter.emit(EVENTS.CLIENT.API_REQUEST, this._stamp({ name: EVENTS.CLIENT.API_REQUEST, meta, runContext }));
            } catch {   }
        }
    }

    
    /**
      * @param {{meta: ApiResponseMeta, runContext?: ObserverRunContext|null}} arg0
     */
        onResponse({ meta, runContext }) {
        if (this._emitter && typeof this._emitter.emit === 'function') {
            const enriched = (meta?.durationMs == null && this._lastRequestTs)
                ? { ...meta, durationMs: Date.now() - this._lastRequestTs }
                : meta;
            try {
                this._emitter.emit(EVENTS.CLIENT.API_RESPONSE, this._stamp({ name: EVENTS.CLIENT.API_RESPONSE, meta: enriched, runContext }));
            } catch {   }
        }
    }

    
    /**
      * @param {{name: string, meta: Record<string, unknown>, runContext?: ObserverRunContext|null}} arg0
      * @returns {unknown}
     */
        _stamp({ name, meta, runContext = null }) {
        const ctx = runContext || this._runContext;
        if (!ctx) return meta;
        return ctx.wrap({ name, payload: meta });
    }

    
    /**
      * @param {{meta: ApiErrorMeta, runContext?: ObserverRunContext|null}} arg0
     */
        onError({ meta, runContext = null }) {
        if (this._emitter && typeof this._emitter.emit === 'function') {
            // A failed call's terminal signal: the `api_response` listeners still see it end.
            if (meta?.ok === false) {
                const { status, ok, durationMs } = meta;
                this.onResponse({ meta: { status, ok, durationMs }, runContext });
            }
            if (meta?.error !== undefined) {
                emitEvent({ emitter: this._emitter, name: EVENTS.CLIENT.API_ERROR, payload: {
                    name: (/** @type {any} */ (meta.error))?.name ?? 'Error',
                    message: (/** @type {any} */ (meta.error))?.message ?? String(meta.error),
                    code: (/** @type {any} */ (meta.error))?.code ?? null
                }, runContext: /** @type {any} */ (runContext ?? this._runContext) });
            }
            if (!this._emitter.listenerCount || this._emitter.listenerCount('error') > 0) {
                try {
                    this._emitter.emit('error', meta.error);
                } catch {   }
            }
        }
    }

     
    /**
     * and the next attempt). Surfaces backoff so callers can observe
     * resilience behavior without depending on the underlying
     * EventEmitter.
     * @param {{meta: ApiRetryMeta, runContext?: ObserverRunContext|null}} arg0 -
     */
        onRetry({ meta, runContext }) {
        if (this._emitter && typeof this._emitter.emit === 'function') {
            try {
                this._emitter.emit(EVENTS.CLIENT.API_RETRY, this._stamp({ name: EVENTS.CLIENT.API_RETRY, meta, runContext }));
            } catch {   }
        }
    }
}


/**
 * Fans one API-call notification out to several observers. Lets an extra
 * observer (an OTLP exporter, a metrics recorder, a test double) run next to
 * the default `EventEmitterApiObserver` without dropping the `api_request` /
 * `api_response` events — existing implementors keep working unchanged.
 *
 * A throwing observer never breaks the others and never breaks the run.
 *
 * @example
 * const observer = new CompositeApiObserver({
 *   observers: [new EventEmitterApiObserver({ emitter }), exporter]
 * });
 * observer.onRequest({ meta: { model: 'gpt-4o' } });
 */
export class CompositeApiObserver {

    /**
     * @param {{observers?: Array<ApiObserver|null|undefined>}} arg0 - The observers to notify (order preserved).
     */
        constructor({ observers = [] } = {}) {
        this._observers = /** @type {Array<ApiObserver>} */ ((Array.isArray(observers) ? observers : []).filter((o) => o && typeof o === 'object'));
    }

    /**
     * @param {{runContext: ObserverRunContext|null}} arg0 -
     */
        setRunContext({ runContext }) {
        this._each({ method: 'setRunContext', args: { runContext } });
    }

    /**
     * @param {{meta: ApiRequestMeta, runContext?: ObserverRunContext|null}} arg0 -
     */
        onRequest({ meta, runContext }) {
        this._each({ method: 'onRequest', args: { meta, runContext } });
    }

    /**
     * @param {{meta: ApiResponseMeta, runContext?: ObserverRunContext|null}} arg0 -
     */
        onResponse({ meta, runContext }) {
        this._each({ method: 'onResponse', args: { meta, runContext } });
    }

    /**
     * @param {{meta: ApiErrorMeta, runContext?: ObserverRunContext|null}} arg0 -
     */
        onError({ meta, runContext = null }) {
        this._each({ method: 'onError', args: { meta, runContext } });
    }

    /**
     * @param {{meta: ApiRetryMeta, runContext?: ObserverRunContext|null}} arg0 -
     */
        onRetry({ meta, runContext }) {
        this._each({ method: 'onRetry', args: { meta, runContext } });
    }

    /**
     * @param {{method: string, args: Record<string, unknown>}} arg0 -
     */
        _each({ method, args }) {
        for (const observer of this._observers) {
            const fn = /** @type {any} */ (observer)[method];
            if (typeof fn !== 'function') continue;
            try {
                fn.call(observer, args);
            } catch {   }
        }
    }
}
