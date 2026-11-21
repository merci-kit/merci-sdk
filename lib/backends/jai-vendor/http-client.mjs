// @ts-check
/**
 * @file JAI HTTP transport client.
 * @version 0.12.0
 *
 * @description
 * Low-level JAI gateway HTTP: fetch with proactive + reactive token refresh,
 * redacted telemetry (api_request/api_response/retry/error), header/body
 * timeouts, JWT expiry decoding, and the deterministic tool-turn retry for
 * the V9 gateway's nondeterministic `tool_message` rejections.
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, stat, chmod } from 'node:fs/promises';
import { SDK_VERSION, AuthType, GatewayEndpoint } from '../../core/constants/index.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { EVENTS, stampEvent } from '../../core/events.mjs';
import { APIStatusError, APIError } from './types.mjs';
import { sleepAbortable } from '../../support/retry-policy.mjs';
import { readBodyTextCapped } from '../../support/body.mjs';
import { AbortedError, ConfigurationError } from '../../core/errors.mjs';
import { createRedirectRefusedError } from '../transport/errors.mjs';
import { ensureEnvLoaded, sdkWarn } from '../../support/utils.mjs';
/**
 * Abort-aware sleep, re-exported from the shared retry-policy module.
 * @param {number} ms - Delay in milliseconds.
 * @param {AbortSignal} [signal] - Optional abort signal.
 * @returns {Promise<void>}
 */
export { sleepAbortable };

/**
 * @typedef {Object} HttpOptions
 * @property {string} token - JWT authentication token (required).
 * @property {string} [authType] - Auth scope (`AuthType.USER` default).
 * @property {string} [endpoint] - Gateway endpoint (`GatewayEndpoint.PRODUCTION` default).
 * @property {number} [streamTimeout] - Inactivity stream timeout in ms.
 * @property {string} [tokenPersistFile] - Secrets file for dotenv-style token persistence.
 * @property {string} [tokenPersistKey] - KEY in `tokenPersistFile` to upsert.
 * @property {string} [userToken] - Original-user impersonation token.
 * @property {string} [originalServiceToken] - Original-service impersonation token.
 * @property {string} [originalApplicationToken] - Original-application impersonation token.
 * @property {string} [applicationUserId] - Application user id header.
 * @property {string} [originalUserCountry] - Original-user country header.
 * @property {string} [originalUserIP] - Original-user IP header.
 * @property {string} [clientExecutionId] - X-Client-Execution-Id (random UUID default).
 * @property {string} [clientFeatureId] - X-Client-Feature-Id header.
 * @property {boolean} [provideDebugInfo] - Send `Grazie-Provide-Debug-Info`.
 */

/**
 * @typedef {Object} FetchOptions
 * @property {string} [method]
 * @property {string|null} [body]
 * @property {Record<string, string>} [headers]
 * @property {AbortSignal} [signal]
 * @property {number} [bodyTimeoutMs]
 * @property {number} [headerTimeoutMs]
 */

/**
 * Resolves the effective header timeout: `JAI_HEADER_TIMEOUT_MS` from
 * secret.env when set to a positive number, otherwise the 600s default.
 * Called at request time so a host-set secret.env is honored.
 * @returns {number} Timeout in milliseconds.
 */
export function headerTimeoutMs() {
    ensureEnvLoaded();
    return LIMITS.jai_header_timeout_ms;
}

/**
 * Resolves the effective control-plane connect timeout:
 * `JAI_CONNECT_TIMEOUT_MS` from secret.env when set to a positive number,
 * otherwise the 30s default.
 * @returns {number} Timeout in milliseconds.
 */
export function connectTimeoutMs() {
    ensureEnvLoaded();
    return LIMITS.jai_connect_timeout_ms;
}

/**
 * Decodes the `exp` claim (ms epoch) from a JWT.
 * @param {{token?: string}} arg0
 * @returns {number|null} Expiry in ms epoch, or null for opaque/non-JWT tokens.
 */
export function jwtExpiresAt({ token }) {
    if (typeof token !== 'string' || !token) return null;
    const payload = token.split('.')[1];
    if (!payload) return null;
    let json;
    try {
        json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    const exp = json?.exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
}

const REDACTED_AUTH_HEADERS = [
    'grazie-authenticate-jwt',
    // Current gateway names (`GrazieHeaders` in the shipped JAI client).
    'grazie-original-user-jwt',
    'grazie-original-service-jwt',
    'grazie-original-application-jwt',
    // Legacy spellings this SDK emitted before the names were corrected.
    'grazie-original-user-token',
    'grazie-original-service-token',
    'grazie-original-application-token',
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
];
/**
 * @param {{headers: Record<string, string>}} arg0
 * @returns {Record<string, string>}
 */
function redactAuthHeaders({ headers }) {
    const redacted = /** @type {Record<string, string>} */ ({ ...(headers ?? {}) });
    for (const name of Object.keys(redacted)) {
        if (REDACTED_AUTH_HEADERS.includes(name.toLowerCase())) redacted[name] = '[REDACTED]';
    }
    return redacted;
}

/**
 * Resolves a Retry-After header (seconds or HTTP-date) into a bounded delay.
 * @param {{retryAfter: string|null|undefined, fallbackMs: number}} arg0
 * @returns {number} Delay in milliseconds, capped at 60s.
 */
export function retryDelayMs({ retryAfter, fallbackMs }) {
    const maxMs = LIMITS.retry_after_max_ms;
    if (retryAfter) {
        const secs = parseInt(retryAfter, 10);
        if (Number.isFinite(secs)) return Math.max(0, Math.min(secs * 1000, maxMs));
        const dateMs = Date.parse(retryAfter);
        if (!Number.isNaN(dateMs)) {
            const delta = dateMs - Date.now();
            if (delta > 0) return Math.min(delta, maxMs);
        }
    }
    return Math.max(0, Math.min(fallbackMs, maxMs));
}

/**
 * Reads an error response body through the shared bounded reader.
 * @param {{response: Response}} arg0
 * @returns {Promise<string>}
 */
async function readErrorBodyText({ response }) {
    return readBodyTextCapped({ response, maxBytes: LIMITS.max_error_body_bytes });
}

/**
 * JAI gateway HTTP client — authenticated fetch with proactive/reactive token
 * refresh, retry policies, redacted telemetry, and header/body timeouts.
 */
export class InternalHttpClient {
    /**
     * @type {import('node:events').EventEmitter}
     */
    #eventEmitter;
    #token; #apiBaseUrl;
    /** @type {Promise<string>|null} */
    #refreshPromise = null;
    #tokenPersistFile; #tokenPersistKey;
    #userToken; #originalServiceToken; #originalApplicationToken;
    #applicationUserId; #originalUserCountry; #originalUserIP;
    #clientExecutionId; #clientFeatureId; #provideDebugInfo;
    streamTimeout;

    /**
 * @param {{options?: Partial<HttpOptions>, eventEmitter?: import('node:events').EventEmitter|null}} arg0
 */
    constructor({ options = {}, eventEmitter }) {
        this.#eventEmitter = /** @type {import('node:events').EventEmitter} */ (eventEmitter);
        const rawStreamTimeout = options.streamTimeout ?? LIMITS.stream_timeout_ms;
        this.streamTimeout = Number.isFinite(rawStreamTimeout) && rawStreamTimeout > 0 ? rawStreamTimeout : LIMITS.stream_timeout_ms;
        const token = options.token;
        if (!token) throw new ConfigurationError({ message: 'An authentication token is required. Provide it via the `token` option.' });
        if (options.tokenPersistKey != null && options.tokenPersistKey !== '') {
            if (typeof options.tokenPersistKey !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.tokenPersistKey)) {
                throw new ConfigurationError({ message: `Invalid tokenPersistKey '${String(options.tokenPersistKey)}'. Expected /^[A-Za-z_][A-Za-z0-9_]*$/.` });
            }
        }
        this.#token = token;
        const authType = options.authType ?? AuthType.USER;
        const endpoint = options.endpoint ?? GatewayEndpoint.PRODUCTION;
        this.#apiBaseUrl = `${endpoint}/${authType}/v5`;

        this.#userToken = options.userToken || null;
        this.#originalServiceToken = options.originalServiceToken || null;
        this.#originalApplicationToken = options.originalApplicationToken || null;
        this.#applicationUserId = options.applicationUserId || null;
        this.#originalUserCountry = options.originalUserCountry || null;
        this.#originalUserIP = options.originalUserIP || null;
        this.#clientExecutionId = options.clientExecutionId || randomUUID();
        this.#clientFeatureId = options.clientFeatureId || null;
        this.#provideDebugInfo = options.provideDebugInfo || false;
        this.#tokenPersistFile = options.tokenPersistFile || null;
        this.#tokenPersistKey = options.tokenPersistKey || null;
    }

    /**
     * The event emitter used for telemetry.
     * @returns {import('node:events').EventEmitter}
     */
    getEventEmitter() { return this.#eventEmitter; }

    /**
     * The current JWT. Read for persistence — the raw token is never emitted.
     * @type {string}
     */
    get token() { return this.#token; }

    /**
 * Emits the redacted `api_request` telemetry for an outbound gateway call.
 * @param {{url: string, method?: string, body?: *, headers: Record<string, string>, extra?: Record<string, any>}} arg0
 */
    #emitApiRequest({ url, method, body, headers, extra }) {
        this.#eventEmitter?.emit(EVENTS.CLIENT.API_REQUEST, stampEvent({ name: EVENTS.CLIENT.API_REQUEST, payload: {
            url,
            method,
            body,
            headers: redactAuthHeaders({ headers }),
            ...(extra ?? {}),
        } }));
    }

    /**
 * Emits the redacted `api_response` telemetry for an inbound gateway response.
 * @param {{url: string, response: Response, startedAt: number}} arg0
 */
    #emitApiResponse({ url, response, startedAt }) {
        const responseHeaders = /** @type {Record<string, string>} */ (response.headers && typeof response.headers.entries === 'function'
            ? Object.fromEntries(response.headers)
            : response.headers);
        this.#eventEmitter?.emit(EVENTS.CLIENT.API_RESPONSE, stampEvent({ name: EVENTS.CLIENT.API_RESPONSE, payload: {
            url,
            status: response.status,
            ok: response.ok,
            headers: redactAuthHeaders({ headers: responseHeaders }),
            durationMs: Date.now() - startedAt,
        } }));
    }

    /**
 * Fetches an endpoint with token refresh and retry policies.
 * @param {{path: string, options: FetchOptions, attempts?: {auth: number, tool: number, general: number}}} arg0
 * @returns {Promise<Response>} The gateway response.
 */
    async _fetchWithRetry({ path, options, attempts = { auth: 0, tool: 0, general: 0 } }) {
        if (attempts.auth === 0) await this.#ensureFreshToken({ signal: options.signal, timeoutMs: connectTimeoutMs() });
        const url = `${this.#apiBaseUrl}${path}`;
        const headers = {
            'Content-Type': 'application/json',
            'Grazie-Agent': JSON.stringify({ name: "js-library-client-jai", version: SDK_VERSION }),
            'Grazie-Authenticate-JWT': this.#token,
            'X-Client-Execution-Id': this.#clientExecutionId,
            ...(this.#userToken ? { 'Grazie-Original-User-JWT': this.#userToken } : {}),
            ...(this.#originalServiceToken ? { 'Grazie-Original-Service-JWT': this.#originalServiceToken } : {}),
            ...(this.#originalApplicationToken ? { 'Grazie-Original-Application-JWT': this.#originalApplicationToken } : {}),
            ...(this.#applicationUserId ? { 'Grazie-Application-User-ID': this.#applicationUserId } : {}),
            ...(this.#originalUserCountry ? { 'Grazie-Original-User-Country': this.#originalUserCountry } : {}),
            ...(this.#originalUserIP ? { 'Grazie-Original-User-IP': this.#originalUserIP } : {}),
            ...(this.#clientFeatureId ? { 'X-Client-Feature-Id': this.#clientFeatureId } : {}),
            ...(this.#provideDebugInfo ? { 'Grazie-Provide-Debug-Info': 'true' } : {}),
            ...options.headers,
        };
        const requestStartTs = Date.now();
        let parsedBody = null;
        if (typeof options.body === 'string') {
            try { parsedBody = JSON.parse(options.body); } catch { parsedBody = null; }
        }
        this.#emitApiRequest({ url, method: options.method, body: options.body, headers,
            extra: parsedBody?.profile ? { model: parsedBody.profile, messages: parsedBody.chat?.messages } : undefined });
        const fetchController = new AbortController();
        const headerMs = (Number.isFinite(options.headerTimeoutMs) && /** @type {number} */ (options.headerTimeoutMs) > 0)
            ? /** @type {number} */ (options.headerTimeoutMs)
            : headerTimeoutMs();
        const headerTimeout = setTimeout(
            () => fetchController.abort(Object.assign(
                new Error(`JAI gateway did not respond with headers within ${headerMs}ms (header timeout)`),
                { code: 'HEADER_TIMEOUT' },
            )),
            headerMs
        );
        const fetchSignal = options.signal
            ? AbortSignal.any([fetchController.signal, options.signal])
            : fetchController.signal;
        let response = await fetch(url, { ...options, headers, signal: fetchSignal, redirect: 'manual' })
            .finally(() => {
                clearTimeout(headerTimeout);
            });
        // Refused before the body is read or a 401 retry: following the redirect
        // would send the gateway JWT and the request body to the target origin.
        if (response.status >= 300 && response.status <= 399) {
            await response.body?.cancel?.().catch(() => {});
            throw createRedirectRefusedError({ location: response.headers.get('location'), requestUrl: url });
        }
        if (options.bodyTimeoutMs && response.ok && response.body && response.status >= 200 && response.status < 300 && response.status !== 204 && response.status !== 205) {
            /** @type {ReturnType<typeof setTimeout>|null} */
            let bodyTimer = setTimeout(
                () => fetchController.abort(Object.assign(
                    new Error(`JAI gateway did not deliver the response body within ${options.bodyTimeoutMs}ms (body timeout)`),
                    { code: 'BODY_TIMEOUT' },
                )),
                options.bodyTimeoutMs
            );
            if (typeof bodyTimer.unref === 'function') bodyTimer.unref();
            const clearBodyTimer = () => { if (bodyTimer) { clearTimeout(bodyTimer); bodyTimer = null; } };
            const reader = /** @type {any} */ (response.body).getReader();
            const guarded = new ReadableStream({
                /** @param {ReadableStreamDefaultController<any>} controller */
                async pull(controller) {
                    try {
                        const { value, done } = await reader.read();
                        if (done) { clearBodyTimer(); controller.close(); return; }
                        controller.enqueue(value);
                    } catch (err) {
                        clearBodyTimer();
                        controller.error(err);
                    }
                },
                cancel(reason) { clearBodyTimer(); return reader.cancel(reason); },
            });
            response = new Response(guarded, { status: response.status, statusText: response.statusText, headers: response.headers });
        }

        this.#emitApiResponse({ url, response, startedAt: requestStartTs });
        if (!response.ok) {
            if (response.status === 401 && attempts.auth === 0) {
                await response.body?.cancel?.().catch(() => {});
                if (options.body != null && typeof options.body !== 'string') {
                    const bodyType = Object.prototype.toString.call(options.body);
                    const error = new APIStatusError({ message: `Cannot retry 401: request body type ${bodyType} is not re-readable`, status: 401, details: {} });
                    if ((this.#eventEmitter?.listenerCount('error') ?? 0) > 0) this.#eventEmitter?.emit('error', error);
                    throw error;
                }
                await this.#refreshTokenOrFail({ signal: options.signal, timeoutMs: connectTimeoutMs() });
                return this._fetchWithRetry({ path, options, attempts: { ...attempts, auth: 1 } });
            }
            let errorDetails;
            let responseText = 'No response body';
            try {
                responseText = await readErrorBodyText({ response });
                errorDetails = JSON.parse(responseText);
            }
            catch (e) {
                const snippet = String(responseText ?? '').slice(0, LIMITS.fix_hint_chars);
                errorDetails = {
                    message: snippet
                        ? `Failed to parse error response from API. Raw body: ${snippet}`
                        : 'Failed to parse error response from API.',
                    responseText: responseText
                };
            }

            const bodyHasToolMessages = Array.isArray(/** @type {any} */ (parsedBody)?.chat?.messages)
                ? /** @type {any} */ (parsedBody).chat.messages.some((/** @type {any} */ m) => m?.type === 'tool_message')
                : (typeof options.body === 'string' && options.body.includes('"type":"tool_message"'));
            const isModelTurnRejection = responseText.includes('Requests ending with a model turn');
            const isThoughtSignatureRejection = responseText.includes('thought_signature');
            const isGatewayToolTurnError = response.status === 400
                && !isModelTurnRejection
                && !isThoughtSignatureRejection
                && (bodyHasToolMessages || responseText.includes('Please use a valid role'))
                && attempts.tool < LIMITS.gateway_tool_turn_retries;
            if (isGatewayToolTurnError) {
                const next = attempts.tool + 1;
                const kind = bodyHasToolMessages && responseText.includes('Please use a valid role')
                    ? 'role-conversion'
                    : bodyHasToolMessages ? 'tool-message turn' : 'role-conversion';
                const delayMs = Math.round(Math.min(LIMITS.tool_turn_backoff_base_ms * 2 ** attempts.tool, LIMITS.tool_turn_backoff_cap_ms) * ((1 - LIMITS.tool_turn_backoff_jitter) + Math.random() * (2 * LIMITS.tool_turn_backoff_jitter)));
                this.#eventEmitter?.emit(EVENTS.CLIENT.API_RETRY, stampEvent({ name: EVENTS.CLIENT.API_RETRY, payload: {
                    vendor: 'jai',
                    attempt: next,
                    nextDelayMs: delayMs,
                    error: { name: 'Error', message: `JAI gateway rejected ${kind} (${response.status}), retry ${next}/${LIMITS.gateway_tool_turn_retries}: ${responseText}`, status: response.status },
                    reason: 'tool-turn-retry',
                    status: response.status,
                } }));
                await sleepAbortable({ ms: delayMs, signal: options.signal });
                return this._fetchWithRetry({ path, options, attempts: { ...attempts, tool: next } });
            }

            if ((response.status === 429 || (response.status >= 500 && response.status < 600)) && attempts.general < LIMITS.transient_retry_attempts) {
                const retryAfter = response.headers.get('Retry-After');
                const jitter = LIMITS.transient_backoff_jitter;
                const delayMs = Math.round(retryDelayMs({ retryAfter, fallbackMs: LIMITS.transient_backoff_base_ms * Math.pow(2, attempts.general) })
                    * ((1 - jitter) + Math.random() * (2 * jitter)));
                this.#eventEmitter?.emit(EVENTS.CLIENT.API_RETRY, stampEvent({ name: EVENTS.CLIENT.API_RETRY, payload: {
                    vendor: 'jai',
                    attempt: attempts.general + 1,
                    nextDelayMs: delayMs,
                    error: { name: 'Error', message: `Transient error ${response.status}`, status: response.status },
                    reason: 'transient-retry',
                    status: response.status,
                } }));
                await sleepAbortable({ ms: delayMs, signal: options.signal });
                return this._fetchWithRetry({ path, options, attempts: { ...attempts, general: attempts.general + 1 } });
            }

            const serverMessage = errorDetails?.message
                ? String(errorDetails.message)
                : (errorDetails?.error?.message ? String(errorDetails.error.message) : null);
            const error = new APIStatusError({ message: serverMessage
                    ? `API request failed with status ${response.status}: ${serverMessage}`
                    : `API request failed with status ${response.status}`, status: response.status, details: errorDetails });
            if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
                /** @type {any} */ (error).nonRetryable = true;
            }
            if ((this.#eventEmitter?.listenerCount('error') ?? 0) > 0) this.#eventEmitter?.emit('error', error);
            throw error;
        }
        if (!response.body) {
            const error = new APIError({ message: 'API returned a successful status but with an empty response body.', status: response.status, details: null });
            if ((this.#eventEmitter?.listenerCount('error') ?? 0) > 0) this.#eventEmitter?.emit('error', error);
            throw error;
        }
        return response;
    }

    /**
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} arg0
 */
    async #ensureFreshToken({ signal = null, timeoutMs = 0 } = {}) {
        const expiresAt = jwtExpiresAt({ token: this.#token });
        if (expiresAt === null || expiresAt > Date.now() + LIMITS.jai_token_refresh_skew_ms) return;
        await this.#refreshTokenOrFail({ signal, timeoutMs });
    }

    /**
     * @param {Object} opts
     * @param {AbortSignal|null} [opts.signal]
     * @param {number} [opts.timeoutMs]
     */
    async #refreshTokenOrFail(opts) {
        try {
            return await this.refreshToken(opts);
        } catch (refreshError) {
            const err = /** @type {any} */ (refreshError);
            if (!err?._merciTokenRefreshEmitted) {
                err._merciTokenRefreshEmitted = true;
                this.#eventEmitter?.emit(EVENTS.CLIENT.TOKEN_REFRESH_FAILURE, stampEvent({ name: EVENTS.CLIENT.TOKEN_REFRESH_FAILURE, payload: {
                    status: err?.status,
                    message: err?.message,
                } }));
            }
            if ((this.#eventEmitter?.listenerCount('error') ?? 0) > 0) this.#eventEmitter?.emit('error', err);
            throw refreshError;
        }
    }

    /**
     * @param {string} newToken
     */
    async #persistToken(newToken) {
        const file = this.#tokenPersistFile;
        const key = this.#tokenPersistKey;
        if (!file || !key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
        if (typeof newToken !== 'string' || !newToken || /[\r\n]/.test(newToken)) return;
        try {
            const existing = await readFile(file, 'utf8').catch(() => '');
            const lines = existing ? existing.split('\n') : [];
            const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const index = lines.findIndex((l) => new RegExp(`^${escaped}=`).test(l));
            if (index === -1) {
                if (lines.length > 0 && lines[lines.length - 1] === '') lines[lines.length - 1] = `${key}=${newToken}`;
                else lines.push(`${key}=${newToken}`);
            } else {
                lines[index] = `${key}=${newToken}`;
            }
            const tmp = `${file}.${randomUUID()}.tmp`;
            await writeFile(tmp, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
            const existingStat = await stat(file).catch(() => null);
            if (existingStat) await chmod(tmp, existingStat.mode);
            await rename(tmp, file);
        } catch (err) {
            sdkWarn({ prefix: 'SDK', args: [`Failed to persist refreshed token to ${file}: ${/** @type {any} */ (err)?.message ?? err}`] });
        }
    }

    /**
 * Performs the JWT refresh round-trip against the gateway.
 * @param {{signal?: AbortSignal|null, timeoutMs?: number}} arg0
 * @returns {Promise<string>} The new token.
 */
    async _refreshToken({ signal = null, timeoutMs = 0 } = {}) {
        const refreshUrl = `${this.#apiBaseUrl}/auth/jwt/refresh/v3`;
        const headers = {
            'Content-Type': 'application/json',
            'Grazie-Authenticate-JWT': this.#token,
        };
        const controller = new AbortController();
        const abortFromSignal = () => controller.abort(signal?.reason);
        if (signal) {
            if (signal.aborted) controller.abort(signal.reason);
            else signal.addEventListener('abort', abortFromSignal, { once: true });
        }
        const refreshTimer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error('Token refresh timed out')), timeoutMs) : null;
        const body = JSON.stringify({});
        const requestStartTs = Date.now();
        this.#emitApiRequest({ url: refreshUrl, method: 'POST', body, headers });
        let response;
        let data;
        try {
            response = await fetch(refreshUrl, { method: 'POST', body, headers, signal: controller.signal, redirect: 'manual' });
            // Same refusal as a gateway call: the refresh request carries the
            // current JWT, and a redirect would hand it to the target origin.
            if (response.status >= 300 && response.status <= 399) {
                await response.body?.cancel?.().catch(() => {});
                throw createRedirectRefusedError({ location: response.headers.get('location'), requestUrl: refreshUrl });
            }
            this.#emitApiResponse({ url: refreshUrl, response, startedAt: requestStartTs });
            if (!response.ok) {
                const error = new APIStatusError({ message: 'Token refresh failed', status: response.status, details: /** @type {Record<string, any>} */ (await response.json().catch(() => ({}))) });
                /** @type {any} */ (error)._merciTokenRefreshEmitted = true;
                this.#eventEmitter?.emit(EVENTS.CLIENT.TOKEN_REFRESH_FAILURE, stampEvent({ name: EVENTS.CLIENT.TOKEN_REFRESH_FAILURE, payload: {
                    status: error.status,
                    message: error.message,
                } }));
                throw error;
            }
            try {
                data = /** @type {any} */ (await response.json());
            } catch (cause) {
                const error = new APIError({ message: 'Invalid JSON in token refresh response', status: response.status, details: { cause } });
                /** @type {any} */ (error)._merciTokenRefreshEmitted = true;
                this.#eventEmitter?.emit(EVENTS.CLIENT.TOKEN_REFRESH_FAILURE, stampEvent({ name: EVENTS.CLIENT.TOKEN_REFRESH_FAILURE, payload: {
                    status: error.status,
                    message: error.message,
                } }));
                throw error;
            }
        } finally {
            clearTimeout(/** @type {NodeJS.Timeout|undefined} */ (refreshTimer ?? undefined));
            signal?.removeEventListener('abort', abortFromSignal);
        }
        if (typeof data?.token !== 'string' || !data.token.trim() || /[\r\n]/.test(data.token)) {
            const error = new APIError({ message: 'Token refresh response did not contain a new token.', status: response.status, details: data });
            /** @type {any} */ (error)._merciTokenRefreshEmitted = true;
            this.#eventEmitter?.emit(EVENTS.CLIENT.TOKEN_REFRESH_FAILURE, stampEvent({ name: EVENTS.CLIENT.TOKEN_REFRESH_FAILURE, payload: {
                status: error.status,
                message: error.message,
            } }));
            throw error;
        }
        return data.token;
    }

    /**
     * Refreshes the JWT (single-flight), persists it, and emits telemetry.
     * The new token is returned and readable via the `token` accessor; the
     * `token_refresh_success` event carries only `{ ok }`.
     *
     * Single-flight is SIGNAL-INDEPENDENT: the shared round-trip runs on an
     * internal timeout, so one waiter aborting neither cancels the others nor
     * the refresh itself (it only stops that waiter from waiting). Success is
     * emitted and persisted exactly once per refresh.
     * @param {Object} [opts={}]
     * @param {AbortSignal|null} [opts.signal] - Stop-waiting signal (does not cancel the shared refresh).
     * @param {number} [opts.timeoutMs=0] - Refresh timeout for the initiator (0 = connectTimeoutMs).
     * @returns {Promise<string>} The new token.
     */
    async refreshToken(opts = {}) {
        if (!this.#refreshPromise) {
            this.#eventEmitter?.emit(EVENTS.CLIENT.TOKEN_REFRESH_START, stampEvent({ name: EVENTS.CLIENT.TOKEN_REFRESH_START, payload: {} }));
            const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : connectTimeoutMs();
            this.#refreshPromise = this._refreshToken({ signal: null, timeoutMs })
                .then(async (newToken) => {
                    if (typeof newToken !== 'string' || !newToken.trim() || /[\r\n]/.test(newToken)) {
                        const error = new APIError({ message: 'Token refresh response did not contain a new token.', status: 200, details: { token: newToken } });
                        throw error;
                    }
                    this.#token = newToken;
                    this.#eventEmitter?.emit(EVENTS.CLIENT.TOKEN_REFRESH_SUCCESS, stampEvent({ name: EVENTS.CLIENT.TOKEN_REFRESH_SUCCESS, payload: { ok: true } }));
                    await this.#persistToken(newToken);
                    return newToken;
                })
                .catch((refreshError) => {
                    const err = /** @type {any} */ (refreshError);
                    if (err && typeof err === 'object' && !err._merciTokenRefreshEmitted) {
                        err._merciTokenRefreshEmitted = true;
                        this.#eventEmitter?.emit(EVENTS.CLIENT.TOKEN_REFRESH_FAILURE, stampEvent({ name: EVENTS.CLIENT.TOKEN_REFRESH_FAILURE, payload: {
                            status: err?.status,
                            message: err?.message,
                        } }));
                    }
                    throw refreshError;
                })
                .finally(() => {
                    this.#refreshPromise = null;
                });
        }
        const pending = this.#refreshPromise;
        const signal = opts.signal;
        if (!signal) return pending;
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                const err = new AbortedError({ message: 'Token refresh wait aborted.', options: { cause: signal.reason } });
                /** @type {any} */ (err)._merciTokenRefreshEmitted = true;
                reject(err);
            };
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
            pending.then(
                (token) => { signal.removeEventListener('abort', onAbort); resolve(token); },
                (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
            );
        });
    }
}
