// @ts-check
/**
 * @file Native Google credential flow (ADC) for the Gemini/Vertex connector.
 * @version 0.22.0
 *
 * @description
 * Reproduces the application-default-credential resolution and token exchange
 * that `@google/genai@2.32.0` gets from `google-auth-library@10.6.2`
 * (`googleauth.js` `getApplicationDefaultAsync` plus `gtoken` and
 * `userRefreshClient`), without the dependency.
 *
 * Resolution order, first hit wins: explicit `credentials`, explicit
 * `keyFile`, `GOOGLE_APPLICATION_CREDENTIALS`, the well-known ADC file, the
 * GCE/GKE metadata server, then a `ConfigurationError` naming all five.
 * `service_account` (RS256 JWT assertion) and `authorized_user` (refresh-token
 * grant) are exchanged for an access token at Google's OAuth endpoint;
 * everything else throws.
 *
 * The factory only stores its options: no fetch, no file system. Resolution
 * runs once, inside the first `getToken()` / `getAuthHeaders()`, and `source`
 * is null until it has. Tokens live in one per-instance cache with a 60 s
 * refresh skew and one shared in-flight request, and every token request runs
 * under the `google_token_timeout_ms` deadline so that request always settles.
 * No token, assertion, key or credential value is ever put into an error
 * message, an error `cause`, or a log.
 */

import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError, AbortedError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { asRecord } from '../../support/object.mjs';
import { createRedirectRefusedError } from './errors.mjs';

/** Google's OAuth 2.0 token endpoint, and the JWT audience. */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** The only scope these credential types are granted for Vertex calls. */
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** The scope set used when the caller supplies none. */
const DEFAULT_SCOPES = [CLOUD_PLATFORM_SCOPE];
/** A token is reused until 60 s before it expires, as the SDK's eager refresh. */
const REFRESH_SKEW_MS = 60_000;
/** The assertion lifetime: `exp = iat + 3600`, as `gtoken` builds it. */
const ASSERTION_LIFETIME_S = 3600;
/** The lifetime assumed when a token response carries no usable `expires_in`. */
const DEFAULT_EXPIRES_IN_S = 3600;
/** The grant type of a JWT-bearer assertion exchange. */
const JWT_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** The metadata host used when `GCE_METADATA_HOST` is unset. */
const DEFAULT_METADATA_HOST = 'metadata.google.internal';
/** How long the metadata availability probe may take before it is "not GCE". */
const PROBE_DEADLINE_MS = 3000;

/**
 * A parsed Google credential JSON (service account or authorized user).
 * @typedef {Record<string, unknown>} CredentialJson
 */

/** @typedef {{email: string, privateKey: string, subject?: string}} ServiceAccountKey */
/** @typedef {{clientId: string, clientSecret: string, refreshToken: string}} AuthorizedUserKey */

/**
 * The credential the resolution picked, with the step it came from.
 * @typedef {{kind: 'service_account', key: ServiceAccountKey, source: string}
 *   | {kind: 'authorized_user', key: AuthorizedUserKey, source: string}
 *   | {kind: 'metadata', base: string, source: string}} Resolution
 */

/** @typedef {{accessToken: string, tokenType: string, expiresAt: number}} TokenEntry */

/**
 * The object `createGoogleAuth` returns: a token, its header, and which
 * resolution step produced the credential (null until the first token call).
 * Both token calls take the caller's signal and refuse at once when it is
 * already aborted, before a cached entry is served.
 * @typedef {Object} GoogleAuth
 * @property {(options?: {signal?: AbortSignal}) => Promise<string>} getToken
 * @property {(options?: {signal?: AbortSignal}) => Promise<Headers>} getAuthHeaders
 * @property {string|null} source
 */

/**
 * base64url of the UTF-8 bytes, as JWS encodes each segment.
 * @param {string} value
 * @returns {string}
 */
function base64url(value) {
    return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * The scopes to request: the caller's set when valid, else `cloud-platform`.
 * @param {{scopes?: string[]}} arg0
 * @returns {string[]}
 */
function resolveScopes({ scopes }) {
    if (scopes === undefined) return [...DEFAULT_SCOPES];
    if (!Array.isArray(scopes) || scopes.length === 0
        || !scopes.every((scope) => typeof scope === 'string' && scope.length > 0)) {
        throw new ConfigurationError({
            message: 'scopes must be a non-empty array of non-empty strings.',
            options: { option: 'scopes' },
        });
    }
    if (!scopes.includes(CLOUD_PLATFORM_SCOPE)) {
        throw new ConfigurationError({
            message: `scopes must include '${CLOUD_PLATFORM_SCOPE}': these credentials are only granted that scope for Vertex calls.`,
            options: { option: 'scopes' },
        });
    }
    return [...scopes];
}

/**
 * The well-known ADC file the gcloud CLI writes, or null when the platform
 * gives no base directory. Only the SDK's own locations: `CLOUDSDK_CONFIG` is
 * deliberately not honoured, matching `google-auth-library@10.6.2`.
 * @returns {string|null}
 */
function wellKnownCredentialsPath() {
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA;
        return appData ? join(appData, 'gcloud', 'application_default_credentials.json') : null;
    }
    const home = process.env.HOME || homedir();
    return home ? join(home, '.config', 'gcloud', 'application_default_credentials.json') : null;
}

/**
 * Reads and parses one credential file. A parse failure never quotes the
 * parser's message and never keeps it as `cause`: V8 may echo a snippet of the
 * text it rejected, and that text holds the private key or a refresh token.
 * @param {{path: string, label: string}} arg0
 * @returns {CredentialJson}
 */
function readCredentialFile({ path, label }) {
    /** @type {string} */
    let text;
    try {
        text = readFileSync(path, 'utf8');
    } catch (error) {
        throw new ConfigurationError({
            message: `Unable to read ${label} at '${path}'.`,
            options: { cause: error },
        });
    }
    /** @type {unknown} */
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        // The parser error is dropped rather than chained: its message can carry
        // the credential it rejected. The message above names only the file.
        throw new ConfigurationError({
            message: `${label} at '${path}' is not valid JSON.`,
        });
    }
    const record = asRecord({ value: parsed });
    if (!record) {
        throw new ConfigurationError({ message: `${label} at '${path}' is not a JSON object.` });
    }
    return record;
}

/**
 * Reads a required string field without ever echoing its value.
 * @param {{record: CredentialJson, field: string, label: string}} arg0
 * @returns {string}
 */
function requireStringField({ record, field, label }) {
    const value = record[field];
    if (typeof value !== 'string' || value.length === 0) {
        throw new ConfigurationError({
            message: `${label} is missing a non-empty string '${field}'.`,
            options: { option: field },
        });
    }
    return value;
}

/**
 * The supported credential types, named in every unsupported-type error.
 * @param {{name: string, label: string}} arg0
 * @returns {never}
 */
function unsupportedCredentialType({ name, label }) {
    throw new ConfigurationError({
        message: `Google credential type '${name}' from ${label} is not supported. `
            + "Supported: 'service_account', 'authorized_user', and the GCE/GKE metadata server.",
        options: { option: 'credentials' },
    });
}

/**
 * Validates one parsed credential JSON and narrows it to the fields the
 * exchange needs. A document without `type` is treated as a service account
 * when it carries both required fields, as the SDK's `JWT` fallback does.
 * @param {{raw: CredentialJson, source: string, label: string}} arg0
 * @returns {Resolution}
 */
function describeCredential({ raw, source, label }) {
    const type = typeof raw.type === 'string' && raw.type.length > 0
        ? raw.type
        : (raw.client_email && raw.private_key ? 'service_account' : 'unknown');

    if (type === 'service_account') {
        const email = requireStringField({ record: raw, field: 'client_email', label });
        const privateKey = requireStringField({ record: raw, field: 'private_key', label });
        if (!privateKey.includes('PRIVATE KEY')) {
            throw new ConfigurationError({
                message: `'service_account' credentials from ${label} have a 'private_key' that is not a PEM private key.`,
                options: { option: 'private_key' },
            });
        }
        const subject = typeof raw.subject === 'string' && raw.subject.length > 0 ? raw.subject : undefined;
        return { kind: 'service_account', source, key: { email, privateKey, subject } };
    }

    if (type === 'authorized_user') {
        if (typeof raw.subject === 'string' && raw.subject.length > 0) {
            throw new ConfigurationError({
                message: `'authorized_user' credentials with a 'subject' (domain-wide delegation) are not supported (${label}). `
                    + "Supported: 'service_account' with a 'subject', 'authorized_user' without one, and the GCE/GKE metadata server.",
                options: { option: 'credentials' },
            });
        }
        return {
            kind: 'authorized_user',
            source,
            key: {
                clientId: requireStringField({ record: raw, field: 'client_id', label }),
                clientSecret: requireStringField({ record: raw, field: 'client_secret', label }),
                refreshToken: requireStringField({ record: raw, field: 'refresh_token', label }),
            },
        };
    }

    return unsupportedCredentialType({ name: type, label });
}

/**
 * `http://<host>/computeMetadata/v1`, accepting a host with or without a
 * scheme the way `GCE_METADATA_HOST` may be written.
 * @param {{host: string}} arg0
 * @returns {string}
 */
function metadataBase({ host }) {
    const rooted = /^https?:\/\//.test(host) ? host : `http://${host}`;
    return `${rooted.replace(/\/+$/, '')}/computeMetadata/v1`;
}

/**
 * Whether a metadata server answers, as `gcp-metadata`'s `isAvailable` probes
 * it. Any failure, including the deadline, means "not running on GCE".
 * @param {{fetch: typeof globalThis.fetch, base: string}} arg0
 * @returns {Promise<boolean>}
 */
async function isMetadataAvailable({ fetch: http, base }) {
    try {
        const response = await http(`${base}/instance`, {
            headers: { 'Metadata-Flavor': 'Google' },
            signal: AbortSignal.timeout(PROBE_DEADLINE_MS),
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Runs the five resolution steps and returns the first that yields a
 * credential. A `keyFile` or environment path that is named but unreadable is
 * a configuration error, not a reason to fall through, as in the SDK.
 * @param {{credentials?: CredentialJson, keyFile?: string, fetch: typeof globalThis.fetch}} arg0
 * @returns {Promise<Resolution>}
 */
async function resolveCredentials({ credentials, keyFile, fetch: http }) {
    if (credentials !== undefined && credentials !== null) {
        const label = 'the credentials argument';
        const record = asRecord({ value: credentials });
        if (!record) {
            throw new ConfigurationError({ message: `${label} must be a parsed Google credential object.`, options: { option: 'credentials' } });
        }
        return describeCredential({ raw: record, source: 'credentials', label });
    }

    if (keyFile !== undefined) {
        if (typeof keyFile !== 'string' || keyFile.length === 0) {
            throw new ConfigurationError({ message: 'keyFile must be a non-empty path string.', options: { option: 'keyFile' } });
        }
        const label = 'the Google credential file from keyFile';
        return describeCredential({ raw: readCredentialFile({ path: keyFile, label }), source: 'keyFile', label });
    }

    const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (envPath) {
        const label = 'the Google credential file from GOOGLE_APPLICATION_CREDENTIALS';
        return describeCredential({ raw: readCredentialFile({ path: envPath, label }), source: 'GOOGLE_APPLICATION_CREDENTIALS', label });
    }

    const wellKnownPath = wellKnownCredentialsPath();
    if (wellKnownPath && existsSync(wellKnownPath)) {
        const label = 'the well-known ADC file';
        return describeCredential({ raw: readCredentialFile({ path: wellKnownPath, label }), source: 'well-known', label });
    }

    const base = metadataBase({ host: process.env.GCE_METADATA_HOST || DEFAULT_METADATA_HOST });
    if (await isMetadataAvailable({ fetch: http, base })) {
        return { kind: 'metadata', source: 'metadata', base };
    }

    throw new ConfigurationError({
        message: 'Could not load Google credentials. Tried, in order: the credentials argument, '
            + `keyFile, GOOGLE_APPLICATION_CREDENTIALS${envPath ? ` ('${envPath}')` : ''}, `
            + `the well-known ADC file${wellKnownPath ? ` ('${wellKnownPath}')` : ''}, `
            + `and the GCE/GKE metadata server (${base}). `
            + 'Set GOOGLE_APPLICATION_CREDENTIALS or run `gcloud auth application-default login`.',
        options: { option: 'credentials' },
    });
}

/**
 * The RS256 assertion `gtoken` signs: header `{alg:'RS256',typ:'JWT'}`, claims
 * `iss`/`scope`/`aud`/`exp`/`iat` and `sub` only when a subject was given.
 * @param {{key: ServiceAccountKey, scopes: string[], now: () => number}} arg0
 * @returns {string}
 */
function serviceAccountAssertion({ key, scopes, now }) {
    const iat = Math.floor(now() / 1000);
    /** @type {Record<string, string|number>} */
    const claims = {
        iss: key.email,
        scope: scopes.join(' '),
        aud: TOKEN_URL,
        exp: iat + ASSERTION_LIFETIME_S,
        iat,
    };
    if (key.subject) claims.sub = key.subject;
    const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
    const signature = createSign('RSA-SHA256').update(signingInput).sign(key.privateKey, 'base64url');
    return `${signingInput}.${signature}`;
}

/**
 * The form body of the token exchange for the resolved credential.
 * @param {{key: ServiceAccountKey|AuthorizedUserKey, kind: 'service_account'|'authorized_user', scopes: string[], now: () => number}} arg0
 * @returns {URLSearchParams}
 */
function tokenRequestBody({ key, kind, scopes, now }) {
    if (kind === 'service_account') {
        const assertion = serviceAccountAssertion({ key: /** @type {ServiceAccountKey} */ (key), scopes, now });
        return new URLSearchParams({ grant_type: JWT_GRANT_TYPE, assertion });
    }
    const refresh = /** @type {AuthorizedUserKey} */ (key);
    return new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: refresh.clientId,
        client_secret: refresh.clientSecret,
        refresh_token: refresh.refreshToken,
    });
}

/**
 * Parses a token response and raises Google's own error words for a non-2xx,
 * keeping the token itself out of every message.
 * @param {{response: Response}} arg0
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonResponse({ response }) {
    const text = await response.text();
    /** @type {unknown} */
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        // The parser echoes the body it rejected, and that body is a token
        // response; only the status is safe to report.
        throw new Error(`Google token response (HTTP ${response.status}) is not valid JSON.`);
    }
    const record = asRecord({ value: payload });
    if (!response.ok) {
        const error = typeof record?.error === 'string' ? record.error : null;
        const description = typeof record?.error_description === 'string' ? record.error_description : null;
        throw new Error(
            `Google token request failed with HTTP ${response.status}${error ? `: ${error}` : ''}${description ? ` (${description})` : ''}.`,
        );
    }
    if (!record) throw new Error(`Google token response (HTTP ${response.status}) is not a JSON object.`);
    return record;
}

/**
 * Validates the token payload and stamps the expiry on the injected clock.
 * A response without a string `access_token` names the shape (its keys) and
 * never any value.
 * @param {{payload: Record<string, unknown>, now: () => number}} arg0
 * @returns {TokenEntry}
 */
function readTokenEntry({ payload, now }) {
    const accessToken = payload.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new Error(
            `Google token response is missing a string access_token (keys: ${Object.keys(payload).join(', ') || 'none'}).`,
        );
    }
    const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0
        ? payload.expires_in
        : DEFAULT_EXPIRES_IN_S;
    const tokenType = typeof payload.token_type === 'string' && payload.token_type.length > 0 ? payload.token_type : 'Bearer';
    return { accessToken, tokenType, expiresAt: now() + expiresIn * 1000 };
}

/**
 * One token HTTP call under the token deadline, the body read included. The
 * signal cancels a real fetch; the race settles the call even when the injected
 * fetch (or a body read that ignores the signal) stalls, so an unresponsive
 * token endpoint cannot wedge the shared `inFlight`. A redirect is refused
 * before its body is read: following it would re-POST the signed assertion or
 * the refresh token to the target origin. The deadline timer is cleared on
 * every path, so a completed call leaves nothing behind.
 * @param {{http: typeof globalThis.fetch, url: string, init: RequestInit}} arg0
 * @returns {Promise<Record<string, unknown>>}
 */
async function tokenRequest({ http, url, init }) {
    const controller = new AbortController();
    const timeout = /** @type {Error & {name: string}} */ (new Error('Google token request timed out.'));
    timeout.name = 'TimeoutError';
    const timer = setTimeout(() => controller.abort(timeout), LIMITS.google_token_timeout_ms);
    timer.unref?.();
    /** @type {Promise<never>} */
    const deadline = new Promise((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    const pending = (async () => {
        const response = await http(url, { ...init, signal: controller.signal, redirect: 'manual' });
        if (response.status >= 300 && response.status <= 399) {
            await response.body?.cancel?.().catch(() => {});
            throw createRedirectRefusedError({ location: response.headers.get('location'), requestUrl: url });
        }
        return readJsonResponse({ response });
    })();
    // The loser of the race must not surface as an unhandled rejection.
    pending.catch(() => {});
    try {
        return await Promise.race([pending, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Waits for `promise`, or rejects with the caller's own abort first. The shared
 * request keeps running for the callers that still want it.
 * @template T
 * @param {{promise: Promise<T>, signal?: AbortSignal}} arg0
 * @returns {Promise<T>}
 */
function raceCallerSignal({ promise, signal }) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new AbortedError({
            message: 'Google token request aborted.',
            options: { cause: signal.reason },
        }));
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
            (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
        );
    });
}

/**
 * One token request for the resolved credential: a JWT-bearer or refresh-token
 * POST, or the metadata server's token endpoint. The assertion body is built
 * per call so every refresh carries a fresh `iat`, not one baked at startup.
 * @param {{resolution: Resolution, scopes: string[], fetch: typeof globalThis.fetch, now: () => number}} arg0
 * @returns {Promise<TokenEntry>}
 */
async function requestToken({ resolution, scopes, fetch: http, now }) {
    if (resolution.kind === 'metadata') {
        const query = new URLSearchParams({ scopes: scopes.join(',') }).toString();
        const url = `${resolution.base}/instance/service-accounts/default/token?${query}`;
        const payload = await tokenRequest({ http, url, init: { headers: { 'Metadata-Flavor': 'Google' } } });
        return readTokenEntry({ payload, now });
    }
    const body = tokenRequestBody({ key: resolution.key, kind: resolution.kind, scopes, now });
    const init = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() };
    const payload = await tokenRequest({ http, url: TOKEN_URL, init });
    return readTokenEntry({ payload, now });
}

/**
 * Resolves Google application-default credentials on first use and exchanges
 * them for an access token, cached per instance. The factory does no I/O: the
 * resolution (file read, env lookup, metadata probe) happens once, inside the
 * first `getToken()` / `getAuthHeaders()`, and is memoised for the instance.
 *
 * @param {{credentials?: CredentialJson, keyFile?: string, scopes?: string[], fetch?: typeof globalThis.fetch, now?: () => number}} [options]
 * @returns {GoogleAuth}
 */
export function createGoogleAuth({
    credentials,
    keyFile,
    scopes,
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now,
} = {}) {
    const resolvedScopes = resolveScopes({ scopes });

    /** @type {string|null} */
    let source = null;
    /** @type {Promise<Resolution>|null} */
    let resolution = null;
    /** @type {TokenEntry|null} */
    let cached = null;
    /** @type {Promise<TokenEntry>|null} */
    let inFlight = null;

    /**
     * The one successful resolution this instance keeps. A rejection clears the
     * memo so a transient probe failure or a not-yet-written ADC file is retried
     * by the next call instead of poisoning a long-lived instance.
     * @returns {Promise<Resolution>}
     */
    function resolveOnce() {
        if (!resolution) {
            resolution = resolveCredentials({ credentials, keyFile, fetch: fetchImpl }).then(
                (resolved) => {
                    source = resolved.source;
                    return resolved;
                },
                (error) => {
                    resolution = null;
                    throw error;
                },
            );
        }
        return resolution;
    }

    /**
     * Resolves, then exchanges. The resolution is shared with every concurrent
     * caller through `resolveOnce`.
     * @returns {Promise<TokenEntry>}
     */
    async function loadToken() {
        const entry = await requestToken({
            resolution: await resolveOnce(),
            scopes: resolvedScopes,
            fetch: fetchImpl,
            now,
        });
        cached = entry;
        return entry;
    }

    /**
     * The cached entry, or the single request every concurrent caller shares.
     * A rejection clears the slot so the next call retries.
     * @param {{signal?: AbortSignal}} [arg0]
     * @returns {Promise<TokenEntry>}
     */
    async function getEntry({ signal } = {}) {
        // The caller's abort is the caller's answer, cached token or not: the
        // request it would feed is already cancelled.
        if (signal?.aborted) {
            throw new AbortedError({ message: 'Google token request aborted.', options: { cause: signal.reason } });
        }
        if (cached && now() < cached.expiresAt - REFRESH_SKEW_MS) return cached;
        if (!inFlight) {
            inFlight = loadToken().finally(() => {
                inFlight = null;
            });
        }
        // A caller that cancels while the shared request runs stops waiting at
        // its own abort; the request itself is not cancelled for the others.
        return raceCallerSignal({ promise: inFlight, signal });
    }

    /**
     * @param {{signal?: AbortSignal}} [arg0]
     * @returns {Promise<string>}
     */
    async function getToken({ signal } = {}) {
        return (await getEntry({ signal })).accessToken;
    }

    /**
     * @param {{signal?: AbortSignal}} [arg0]
     * @returns {Promise<Headers>}
     */
    async function getAuthHeaders({ signal } = {}) {
        const entry = await getEntry({ signal });
        return new Headers({ Authorization: `${entry.tokenType} ${entry.accessToken}` });
    }

    return {
        getToken,
        getAuthHeaders,
        /** The resolution step that produced the credential, or null before the first token call. */
        get source() {
            return source;
        },
    };
}
