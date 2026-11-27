// @ts-check


/**
 * @file Mountable HTTP handler for the operator API.
 * @version 0.12.0
 *
 * @description
 * `createOperatorHttpHandler` answers four routes on a server the host creates:
 * the plain-text status page, the JSON state, one item's JSON detail (canonical
 * `<base>/items/<id>` plus the `<base>/<id>` alias), and `POST <base>/refresh`.
 * The Host allowlist is the security boundary; the handler never adds CORS and
 * never copies a provider message or a stack into a response.
 *
 * Every route is exact, every method is checked, and the refresh body is capped
 * and ignored. A snapshot throw, a non-object (an array included), or a
 * thenable yields `503 snapshot_unavailable`; a rejecting thenable gets a
 * rejection handler so it cannot become an unhandled rejection. The handler
 * itself never throws: a top-level catch answers `500 internal_error` in JSON,
 * or the fixed text `internal error` on the status route, when the response is
 * still writable, and ends silently otherwise.
 *
 * The host owns the server, its bind address, and TLS. This module imports no
 * HTTP server; the `node:http` references are type-only JSDoc imports.
 */

import { configurationError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { requestHostAllowed } from '../../support/utils.mjs';
import { toIso, toItemResponse, toStateResponse } from './view.mjs';
import { formatStatus } from './status.mjs';

/**
 * The fixed error messages (§3.6). Nothing here comes from a provider.
 * @type {Readonly<Record<string, string>>}
 */
const ERROR_MESSAGES = Object.freeze({
    forbidden_host: 'Forbidden host.',
    not_found: 'Not found.',
    method_not_allowed: 'Method not allowed.',
    invalid_identifier: 'Invalid work item identifier.',
    item_not_found: 'Work item not found.',
    snapshot_unavailable: 'Snapshot unavailable.',
    unsupported_media_type: 'Unsupported media type.',
    payload_too_large: 'Payload too large.',
    refresh_not_supported: 'Refresh is not supported.',
    not_started: 'Scheduler is not started.',
    stopped: 'Scheduler is stopped.',
    refresh_failed: 'Refresh failed.',
    internal_error: 'Internal error.'
});

/** The operations a refresh request asks the scheduler for. */
const REFRESH_OPERATIONS = Object.freeze(['poll', 'reconcile']);

/**
 * @typedef {Object} MatchedRoute
 * @property {'status'|'state'|'item'|'refresh'|'bad_identifier'} kind
 * @property {'GET'|'POST'} method
 * @property {string} [id]
 */

/**
 * @param {{res: import('node:http').ServerResponse}} arg0
 * @returns {boolean}
 */
function canWrite({ res }) {
    return !res.headersSent && !res.destroyed && !res.writableEnded;
}

/**
 * A last-resort end for a response that cannot carry the JSON envelope.
 * @param {{res: import('node:http').ServerResponse}} arg0
 */
function endSilently({ res }) {
    if (res.destroyed || res.writableEnded) return;
    try {
        res.end();
    } catch {
        // The socket is already gone; nothing else can be written.
    }
}

/**
 * Write one JSON response (or the fixed error envelope).
 * @param {{
 *   res: import('node:http').ServerResponse,
 *   status: number,
 *   payload?: unknown,
 *   code?: string,
 *   allow?: string,
 *   onSent?: () => void
 * }} arg0
 * @returns {boolean}
 */
function sendJson({ res, status, payload, code, allow, onSent }) {
    if (!canWrite({ res })) return false;
    /** @type {Record<string, string>} */
    const headers = {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8'
    };
    if (allow !== undefined) headers.allow = allow;
    const body = payload === undefined
        ? { error: { code, message: ERROR_MESSAGES[code ?? 'internal_error'] } }
        : payload;
    res.writeHead(status, headers);
    res.end(JSON.stringify(body), onSent);
    return true;
}

/**
 * Write the plain-text status response or its text error (never JSON).
 * @param {{res: import('node:http').ServerResponse, status: number, text: string}} arg0
 * @returns {boolean}
 */
function sendText({ res, status, text }) {
    if (!canWrite({ res })) return false;
    res.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8'
    });
    res.end(text);
    return true;
}

/**
 * Decode one path segment against the route contract. An empty value, a
 * decoded `/`, or a malformed escape is not an identifier.
 * @param {{segment: string}} arg0
 * @returns {string|null}
 */
function decodeSegment({ segment }) {
    if (segment === '') return null;
    /** @type {string} */
    let decoded;
    try {
        decoded = decodeURIComponent(segment);
    } catch {
        return null;
    }
    if (decoded === '' || decoded.includes('/')) return null;
    return decoded;
}

/**
 * Read the stable reason from a scheduler error, if it carries one.
 * @param {{error: unknown}} arg0
 * @returns {'not_started'|'stopped'|null}
 */
function refreshReason({ error }) {
    try {
        const candidate = error && typeof error === 'object'
            ? /** @type {{options?: unknown, reason?: unknown}} */ (error)
            : {};
        const options = candidate.options && typeof candidate.options === 'object'
            ? /** @type {{reason?: unknown}} */ (candidate.options)
            : {};
        if (options.reason === 'not_started' || options.reason === 'stopped') return options.reason;
        if (candidate.reason === 'not_started' || candidate.reason === 'stopped') return candidate.reason;
    } catch {
        // A hostile getter is not a reason; the caller maps it to refresh_failed.
    }
    return null;
}

/**
 * Drain at most `maxBodyBytes` of a request body. The content is ignored; only
 * the size and the abort signal matter.
 *
 * shortcut: this deliberately duplicates the A2A handler's drain loop
 * (`lib/tools/a2a-server.mjs`). A2A collects and parses JSON-RPC while this
 * discards content and measures size. The third HTTP handler (MCP) delegates
 * body reading to its SDK, so no third same-contract drain exists. Share only
 * when another discard-and-measure handler appears.
 * @param {{req: import('node:http').IncomingMessage, maxBodyBytes: number}} arg0
 * @returns {Promise<'ok'|'too_large'|'aborted'>}
 */
function drainBody({ req, maxBodyBytes }) {
    return new Promise((resolve) => {
        let bytes = 0;
        let settled = false;
        /** @type {() => void} */
        let cleanup = () => {};
        /** @param {'ok'|'too_large'|'aborted'} result */
        const finish = (result) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        };
        const onData = (/** @type {Buffer|string} */ chunk) => {
            bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
            if (bytes > maxBodyBytes) finish('too_large');
        };
        const onEnd = () => finish('ok');
        const onError = () => finish('aborted');
        const onAborted = () => finish('aborted');
        cleanup = () => {
            req.off('data', onData);
            req.off('end', onEnd);
            req.off('error', onError);
            req.off('aborted', onAborted);
        };
        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', onError);
        req.on('aborted', onAborted);
        if (req.destroyed && !req.readableEnded) finish('aborted');
    });
}

/**
 * Create a `(req, res) => Promise<void>` operator handler (§3.3).
 *
 * `queued: true` means this request invoked `refresh()`; `coalesced: true`
 * means another handler request was already invoking it. A scheduler-internal
 * in-flight tick is invisible to this handler (A14).
 * @param {{
 *   getSnapshot: () => Record<string, unknown>,
 *   getPolicySnapshot?: (() => Record<string, unknown>)|null,
 *   refresh?: (() => Promise<unknown>)|null,
 *   recentEvents?: ((arg0: { identifier?: unknown, limit?: number }) => Array<Record<string, unknown>>)|null,
 *   basePath?: string,
 *   statusPath?: string|null,
 *   allowedHosts?: string[],
 *   allowAnyHost?: boolean,
 *   maxBodyBytes?: number,
 *   recentEventsLimit?: number,
 *   statusMaxRows?: number,
 *   now?: () => number
 * }} [arg0]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createOperatorHttpHandler({
    getSnapshot,
    getPolicySnapshot = null,
    refresh = null,
    recentEvents = null,
    basePath = '/api/v1',
    statusPath = '/',
    allowedHosts = ['localhost', '127.0.0.1', '::1'],
    allowAnyHost = false,
    maxBodyBytes = LIMITS.operator_max_body_bytes,
    recentEventsLimit = LIMITS.operator_recent_events_limit,
    statusMaxRows = LIMITS.operator_status_max_rows,
    now = Date.now
} = /** @type {never} */ ({})) {
    if (typeof getSnapshot !== 'function') {
        throw configurationError({ option: 'invalid_get_snapshot', message: 'createOperatorHttpHandler requires getSnapshot to be a function' });
    }
    if (getPolicySnapshot !== null && typeof getPolicySnapshot !== 'function') {
        throw configurationError({ option: 'invalid_get_policy_snapshot', message: 'createOperatorHttpHandler requires getPolicySnapshot to be a function or null' });
    }
    if (refresh !== null && typeof refresh !== 'function') {
        throw configurationError({ option: 'invalid_refresh', message: 'createOperatorHttpHandler requires refresh to be a function or null' });
    }
    if (recentEvents !== null && typeof recentEvents !== 'function') {
        throw configurationError({ option: 'invalid_recent_events', message: 'createOperatorHttpHandler requires recentEvents to be a function or null' });
    }
    if (typeof basePath !== 'string' || basePath === '' || basePath === '/'
        || !basePath.startsWith('/') || /[?#\s]/.test(basePath)) {
        throw configurationError({ option: 'invalid_base_path', message: 'createOperatorHttpHandler requires basePath to start with / and not be /' });
    }
    const normalizedBasePath = basePath.replace(/\/+$/, '');
    if (normalizedBasePath === '' || normalizedBasePath === '/') {
        throw configurationError({ option: 'invalid_base_path', message: 'createOperatorHttpHandler requires basePath to start with / and not be /' });
    }
    /** @type {string|null} */
    let normalizedStatusPath = null;
    if (statusPath !== null) {
        if (typeof statusPath !== 'string' || !statusPath.startsWith('/')) {
            throw configurationError({ option: 'invalid_status_path', message: 'createOperatorHttpHandler requires statusPath to be null or a path starting with /' });
        }
        normalizedStatusPath = statusPath === '/' ? '/' : statusPath.replace(/\/+$/, '');
        if (normalizedStatusPath === '') normalizedStatusPath = '/';
        const jsonRoutes = [
            normalizedBasePath,
            `${normalizedBasePath}/state`,
            `${normalizedBasePath}/refresh`,
            `${normalizedBasePath}/items`
        ];
        if (jsonRoutes.includes(normalizedStatusPath)) {
            throw configurationError({ option: 'status_path_collision', message: 'createOperatorHttpHandler statusPath collides with a JSON route' });
        }
        // Any fixed path one segment below `/items/` shadows that item; the
        // alias prefix keeps `state`/`refresh`/`items` reserved as before.
        const itemPrefix = `${normalizedBasePath}/items/`;
        if (normalizedStatusPath.startsWith(itemPrefix)) {
            const itemSegment = normalizedStatusPath.slice(itemPrefix.length);
            if (itemSegment !== '' && !itemSegment.includes('/')) {
                throw configurationError({ option: 'status_path_collision', message: 'createOperatorHttpHandler statusPath collides with an item route' });
            }
        }
        const aliasPrefix = `${normalizedBasePath}/`;
        if (normalizedStatusPath.startsWith(aliasPrefix)) {
            const segment = normalizedStatusPath.slice(aliasPrefix.length);
            if (segment !== '' && !segment.includes('/')
                && segment !== 'state' && segment !== 'refresh' && segment !== 'items') {
                throw configurationError({ option: 'status_path_collision', message: 'createOperatorHttpHandler statusPath collides with an item route' });
            }
        }
    }
    if (!Array.isArray(allowedHosts) || allowedHosts.length === 0
        || allowedHosts.some((host) => typeof host !== 'string' || host === '')) {
        throw configurationError({ option: 'invalid_allowed_hosts', message: 'createOperatorHttpHandler requires allowedHosts to be a non-empty string array' });
    }
    if (typeof allowAnyHost !== 'boolean') {
        throw configurationError({ option: 'invalid_allow_any_host', message: 'createOperatorHttpHandler requires allowAnyHost to be a boolean' });
    }
    if (typeof maxBodyBytes !== 'number' || !Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
        throw configurationError({ option: 'invalid_max_body_bytes', message: 'createOperatorHttpHandler requires maxBodyBytes to be an integer >= 1' });
    }
    if (typeof recentEventsLimit !== 'number' || !Number.isInteger(recentEventsLimit) || recentEventsLimit < 1) {
        throw configurationError({ option: 'invalid_recent_events_limit', message: 'createOperatorHttpHandler requires recentEventsLimit to be an integer >= 1' });
    }
    if (typeof statusMaxRows !== 'number' || !Number.isInteger(statusMaxRows) || statusMaxRows < 1) {
        throw configurationError({ option: 'invalid_status_max_rows', message: 'createOperatorHttpHandler requires statusMaxRows to be an integer >= 1' });
    }
    if (typeof now !== 'function') {
        throw configurationError({ option: 'invalid_now', message: 'createOperatorHttpHandler requires now to be a function' });
    }

    let refreshing = false;

    /**
     * A synchronous snapshot read. A throw, a non-object, and a thenable are
     * all "unavailable"; a thenable gets a rejection handler so it cannot
     * surface as an unhandled rejection.
     * @returns {Record<string, unknown>|null}
     */
    function readSnapshot() {
        /** @type {unknown} */
        let snapshot;
        try {
            snapshot = getSnapshot();
        } catch {
            return null;
        }
        try {
            if (snapshot && typeof snapshot === 'object'
                && typeof /** @type {{then?: unknown}} */ (snapshot).then === 'function') {
                const thenable = /** @type {{catch?: (handler: () => void) => unknown, then: (onFulfilled: unknown, onRejected: () => void) => unknown}} */ (snapshot);
                if (typeof thenable.catch === 'function') thenable.catch(() => {});
                else thenable.then(undefined, () => {});
                return null;
            }
        } catch {
            return null;
        }
        return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
            ? /** @type {Record<string, unknown>} */ (snapshot)
            : null;
    }

    /**
     * The policy's health, when the host wired one. A throwing or malformed
     * provider yields `null` (the response carries `policy: null`) instead of
     * failing the whole route: the policy surface must never take the operator
     * API down.
     * @returns {Record<string, unknown>|null}
     */
    function readPolicy() {
        if (typeof getPolicySnapshot !== 'function') return null;
        try {
            const policy = getPolicySnapshot();
            if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;
            // Copy inside the try: a hostile getter on the snapshot must degrade
            // to `null`, not turn the route into a 500.
            const copy = { .../** @type {Record<string, unknown>} */ (policy) };
            const lastError = copy.lastError;
            if (lastError && typeof lastError === 'object' && !Array.isArray(lastError)) {
                copy.lastError = { .../** @type {Record<string, unknown>} */ (lastError) };
            }
            return copy;
        } catch {
            return null;
        }
    }

    /**
     * Match one pathname against the exact route set (§3.6).
     * @param {{pathname: string}} arg0
     * @returns {MatchedRoute|null}
     */
    function matchRoute({ pathname }) {
        if (normalizedStatusPath !== null && pathname === normalizedStatusPath) {
            return { kind: 'status', method: 'GET' };
        }
        if (pathname === `${normalizedBasePath}/state`) return { kind: 'state', method: 'GET' };
        if (pathname === `${normalizedBasePath}/refresh`) return { kind: 'refresh', method: 'POST' };
        // `/items` with no segment is not an item route; `/items/` is a bad id.
        if (pathname === `${normalizedBasePath}/items`) return null;

        /** @type {string|null} */
        let segment = null;
        const itemsPrefix = `${normalizedBasePath}/items/`;
        if (pathname.startsWith(itemsPrefix)) {
            // An item path is always identifiable: a multi-segment remainder is
            // an invalid identifier (the documented 400), not an unknown route.
            segment = pathname.slice(itemsPrefix.length);
        } else if (pathname.startsWith(`${normalizedBasePath}/`)) {
            const alias = pathname.slice(normalizedBasePath.length + 1);
            // The alias is exactly one segment; a deeper path is not a route.
            if (alias.includes('/')) return null;
            segment = alias;
        }
        if (segment === null) return null;
        const id = decodeSegment({ segment });
        return id === null
            ? { kind: 'bad_identifier', method: 'GET' }
            : { kind: 'item', method: 'GET', id };
    }

    /**
     * The refresh route, in the documented order: provider, media type, body
     * cap, snapshot precheck, then coalescing and the awaited refresh.
     * @param {{req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse}} arg0
     * @returns {Promise<void>}
     */
    async function handleRefresh({ req, res }) {
        if (typeof refresh !== 'function') {
            sendJson({ res, status: 501, code: 'refresh_not_supported' });
            return;
        }
        const rawType = req.headers['content-type'];
        const mediaType = typeof rawType === 'string' ? rawType.split(';')[0].trim().toLowerCase() : '';
        if (mediaType !== 'application/json') {
            sendJson({ res, status: 415, code: 'unsupported_media_type' });
            return;
        }
        const rawLength = req.headers['content-length'];
        if (typeof rawLength === 'string' && /^\d+$/.test(rawLength.trim())
            && Number(rawLength) > maxBodyBytes) {
            sendJson({ res, status: 413, code: 'payload_too_large' });
            return;
        }
        const drained = await drainBody({ req, maxBodyBytes });
        if (drained === 'aborted') return;
        if (drained === 'too_large') {
            sendJson({
                res,
                status: 413,
                code: 'payload_too_large',
                onSent: () => {
                    try {
                        req.destroy();
                    } catch {
                        // The request is already gone.
                    }
                }
            });
            return;
        }
        const snapshot = readSnapshot();
        if (snapshot === null) {
            sendJson({ res, status: 503, code: 'snapshot_unavailable' });
            return;
        }
        if (snapshot.stopped === true) {
            sendJson({ res, status: 409, code: 'stopped' });
            return;
        }
        if (snapshot.started === false) {
            sendJson({ res, status: 409, code: 'not_started' });
            return;
        }

        const requestedAt = toIso(now());
        if (refreshing) {
            sendJson({
                res,
                status: 202,
                payload: { queued: false, coalesced: true, requestedAt, operations: REFRESH_OPERATIONS }
            });
            return;
        }
        refreshing = true;
        try {
            await refresh();
        } catch (error) {
            const reason = refreshReason({ error });
            if (reason !== null) sendJson({ res, status: 409, code: reason });
            else sendJson({ res, status: 503, code: 'refresh_failed' });
            return;
        } finally {
            refreshing = false;
        }
        sendJson({
            res,
            status: 202,
            payload: { queued: true, coalesced: false, requestedAt, operations: REFRESH_OPERATIONS }
        });
    }

    /**
     * The `(req, res)` HTTP contract: the positional signature is the server
     * contract, not an SDK-internal callable.
     */
    /** @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} */
    const handler = async (req, res) => {
        /** @type {MatchedRoute|null} */
        let route = null;
        try {
            if (!requestHostAllowed({ req, allowedHosts, allowAnyHost })) {
                sendJson({ res, status: 403, code: 'forbidden_host' });
                return;
            }
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            route = matchRoute({ pathname: url.pathname });
            if (route === null) {
                sendJson({ res, status: 404, code: 'not_found' });
                return;
            }
            if (req.method !== route.method) {
                sendJson({ res, status: 405, code: 'method_not_allowed', allow: route.method });
                return;
            }
            if (route.kind === 'bad_identifier') {
                sendJson({ res, status: 400, code: 'invalid_identifier' });
                return;
            }
            if (route.kind === 'status') {
                const snapshot = readSnapshot();
                if (snapshot === null) {
                    sendText({ res, status: 503, text: 'snapshot unavailable' });
                    return;
                }
                sendText({ res, status: 200, text: formatStatus({ snapshot, policy: readPolicy(), now, maxRows: statusMaxRows }) });
                return;
            }
            if (route.kind === 'state') {
                const snapshot = readSnapshot();
                if (snapshot === null) {
                    sendJson({ res, status: 503, code: 'snapshot_unavailable' });
                    return;
                }
                sendJson({ res, status: 200, payload: toStateResponse({ snapshot, policy: readPolicy(), now }) });
                return;
            }
            if (route.kind === 'item') {
                const snapshot = readSnapshot();
                if (snapshot === null) {
                    sendJson({ res, status: 503, code: 'snapshot_unavailable' });
                    return;
                }
                const item = toItemResponse({
                    snapshot,
                    id: route.id,
                    now,
                    events: recentEvents,
                    eventsLimit: recentEventsLimit
                });
                if (item === null) {
                    sendJson({ res, status: 404, code: 'item_not_found' });
                    return;
                }
                sendJson({ res, status: 200, payload: item });
                return;
            }
            await handleRefresh({ req, res });
        } catch {
            if (!canWrite({ res })) {
                endSilently({ res });
                return;
            }
            // The status route answers text on every path, including this one.
            if (route !== null && route.kind === 'status') {
                sendText({ res, status: 500, text: 'internal error' });
                return;
            }
            sendJson({ res, status: 500, code: 'internal_error' });
        }
    };

    return handler;
}
