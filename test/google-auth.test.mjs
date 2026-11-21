// @ts-check
/**
 * @file Native Google credential flow tests.
 * @version 0.22.0
 *
 * @description
 * Drives `createGoogleAuth` offline with an injected `fetch` and clock: the
 * factory stays inert, resolution happens once inside the first token call, the
 * RS256 assertion is verified against a throwaway public key, the resolution
 * steps are exercised in order, and the cache, expiry, in-flight dedupe and
 * secret hygiene of the token exchange are asserted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGoogleAuth } from '../lib/backends/transport/google-auth.mjs';
import { AbortedError, ConfigurationError } from '../lib/core/errors.mjs';

const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLIENT_EMAIL = 'vertex@merci-test.iam.gserviceaccount.com';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/**
 * One recorded request, flattened so assertions stay readable. Header names are
 * normalized to lower case by `Headers`.
 * @typedef {{url: string, method: string, headers: Record<string, string>, body: string, redirect?: string}} RecordedCall
 */

/**
 * A fetch that records every call and answers from `handler`.
 * @param {(arg0: RecordedCall) => Response|Promise<Response>} handler
 * @returns {{fetch: typeof fetch, calls: RecordedCall[]}}
 */
function recorder(handler) {
    /** @type {RecordedCall[]} */
    const calls = [];
    /** @type {typeof fetch} */
    const fetchStub = async (input, init) => {
        const call = {
            url: String(input),
            method: init?.method ?? 'GET',
            headers: /** @type {Record<string, string>} */ (Object.fromEntries(new Headers(init?.headers))),
            body: typeof init?.body === 'string' ? init.body : '',
            redirect: init?.redirect,
        };
        calls.push(call);
        return handler(call);
    };
    return { fetch: fetchStub, calls };
}

/**
 * The token endpoint answer Google sends for a good exchange.
 * @param {{accessToken?: string, expiresIn?: number, tokenType?: string}} [arg0]
 * @returns {Response}
 */
function tokenResponse({ accessToken = 'ya29.test-token', expiresIn = 3600, tokenType = 'Bearer' } = {}) {
    return new Response(
        JSON.stringify({ access_token: accessToken, expires_in: expiresIn, token_type: tokenType }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

/**
 * A service-account credential JSON that validates, signed by the throwaway key.
 * @param {{subject?: string}} [arg0]
 * @returns {Record<string, unknown>}
 */
function serviceAccount({ subject } = {}) {
    return {
        type: 'service_account',
        project_id: 'merci-test',
        client_email: CLIENT_EMAIL,
        private_key: privateKeyPem,
        ...(subject ? { subject } : {}),
    };
}

/**
 * Points the ambient lookups at an empty temp home and clears the env paths, so
 * the machine's real ADC file cannot decide a test.
 * @returns {() => void} restores the environment and removes the temp home
 */
function isolateAmbientCredentials() {
    const saved = {
        HOME: process.env.HOME,
        APPDATA: process.env.APPDATA,
        GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        GCE_METADATA_HOST: process.env.GCE_METADATA_HOST,
    };
    const home = mkdtempSync(join(tmpdir(), 'merci-google-auth-home-'));
    process.env.HOME = home;
    delete process.env.APPDATA;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GCE_METADATA_HOST;
    return () => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(home, { recursive: true, force: true });
    };
}

/**
 * Writes a credential JSON to a fresh temp file.
 * @param {Record<string, unknown>} credential
 * @returns {{path: string, remove: () => void}}
 */
function tempCredentialFile(credential) {
    const dir = mkdtempSync(join(tmpdir(), 'merci-google-auth-'));
    const path = join(dir, 'credential.json');
    writeFileSync(path, JSON.stringify(credential), 'utf8');
    return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Splits a JWS and decodes both segments.
 * @param {string} assertion
 * @returns {{header: Record<string, unknown>, claims: Record<string, unknown>, signedInput: string, signature: Buffer}}
 */
function decodeAssertion(assertion) {
    const [headerPart, claimsPart, signaturePart] = assertion.split('.');
    return {
        header: JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')),
        claims: JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8')),
        signedInput: `${headerPart}.${claimsPart}`,
        signature: Buffer.from(signaturePart, 'base64url'),
    };
}

/**
 * The assertion one recorded token POST carried, verified against the public key.
 * @param {RecordedCall} call
 * @returns {Record<string, unknown>}
 */
function verifiedClaims(call) {
    const { claims, signedInput, signature } = decodeAssertion(/** @type {string} */ (new URLSearchParams(call.body).get('assertion')));
    assert.equal(
        verify('RSA-SHA256', Buffer.from(signedInput, 'utf8'), keyPair.publicKey, signature),
        true,
        'the assertion verifies with the matching public key',
    );
    return claims;
}

/**
 * A fetch that must never be reached; used where resolution fails first.
 * @type {typeof fetch}
 */
const noNetwork = async () => {
    throw new Error('the test must not reach the network');
};

/**
 * `promise`'s outcome, or a rejection naming the call after `ms`, so a wedged
 * call fails the test instead of hanging the whole run.
 * @param {{promise: Promise<unknown>, ms: number, label: string}} arg0
 * @returns {Promise<unknown>}
 */
async function settledWithin({ promise, ms, label }) {
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} still pending after ${ms}ms`)), ms);
    });
    try {
        return await Promise.race([promise, deadline]);
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

/**
 * Every message on an error's `cause` chain, first error included. The chain is
 * where a wrapped parser error would keep the input it rejected.
 * @param {unknown} error
 * @returns {Array<string>}
 */
function causeChainMessages(error) {
    /** @type {Array<string>} */
    const messages = [];
    /** @type {any} */
    let current = error;
    for (let depth = 0; current && depth < 10; depth += 1) {
        messages.push(String(current.message ?? ''));
        current = current.cause;
    }
    return messages;
}

/** What no error, at any depth of its cause chain, may quote. */
const LEAKED_SECRETS = ['ya29.secret-value', 'access_token', 'private_key', 'BEGIN PRIVATE KEY', 'MII'];

test('service account: the factory is inert until the first token call, then signs and caches', async () => {
    const restore = isolateAmbientCredentials();
    try {
        const { fetch, calls } = recorder(() => tokenResponse());
        const auth = createGoogleAuth({ credentials: serviceAccount(), fetch, now: () => 1_700_000_000_000 });
        assert.equal(auth.source, null, 'source is unset before the first token call');
        assert.equal(calls.length, 0, 'the factory performs no fetch');

        assert.equal(await auth.getToken(), 'ya29.test-token');
        assert.equal(auth.source, 'credentials');
        assert.equal(await auth.getToken(), 'ya29.test-token');
        assert.equal(calls.length, 1, 'the second getToken is served from the cache');

        const [call] = calls;
        assert.equal(call.url, TOKEN_URL);
        assert.equal(call.method, 'POST');
        assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
        const body = new URLSearchParams(call.body);
        assert.deepEqual([...body.keys()], ['grant_type', 'assertion']);
        assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');

        const { header } = decodeAssertion(/** @type {string} */ (body.get('assertion')));
        assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
        const claims = verifiedClaims(call);
        assert.deepEqual(claims, {
            iss: CLIENT_EMAIL,
            scope: CLOUD_PLATFORM,
            aud: TOKEN_URL,
            exp: 1_700_003_600,
            iat: 1_700_000_000,
        });
        assert.equal(/** @type {number} */ (claims.exp) - /** @type {number} */ (claims.iat), 3600);

        const headers = await auth.getAuthHeaders();
        assert.equal(headers.get('authorization'), 'Bearer ya29.test-token');
        assert.equal(calls.length, 1, 'getAuthHeaders reuses the cached token');
    } finally {
        restore();
    }
});

test('service account: a subject becomes the sub claim', async () => {
    const restore = isolateAmbientCredentials();
    try {
        const { fetch, calls } = recorder(() => tokenResponse());
        const auth = createGoogleAuth({ credentials: serviceAccount({ subject: 'admin@example.com' }), fetch, now: () => 0 });
        await auth.getToken();
        assert.equal(verifiedClaims(calls[0]).sub, 'admin@example.com');
    } finally {
        restore();
    }
});

test('service account: two concurrent getToken calls share one POST', async () => {
    const restore = isolateAmbientCredentials();
    try {
        /** @type {() => void} */
        let release = () => {};
        const gate = new Promise((resolve) => { release = () => resolve(undefined); });
        const { fetch, calls } = recorder(async () => {
            await gate;
            return tokenResponse();
        });
        const auth = createGoogleAuth({ credentials: serviceAccount(), fetch, now: () => 0 });
        const first = auth.getToken();
        const second = auth.getToken();
        release();
        assert.deepEqual(await Promise.all([first, second]), ['ya29.test-token', 'ya29.test-token']);
        assert.equal(calls.length, 1, 'one in-flight request serves both callers');
    } finally {
        restore();
    }
});

test('service account: the token is refreshed past expiresAt - 60 s with a freshly signed assertion', async () => {
    const restore = isolateAmbientCredentials();
    try {
        let clock = 1_000_000;
        let served = 0;
        const { fetch, calls } = recorder(() => tokenResponse({ accessToken: `tok-${++served}` }));
        const auth = createGoogleAuth({ credentials: serviceAccount(), fetch, now: () => clock });
        assert.equal(await auth.getToken(), 'tok-1');
        clock += 3_600_000 - 60_000 - 1;
        assert.equal(await auth.getToken(), 'tok-1', 'still inside the refresh window');
        clock += 1;
        assert.equal(await auth.getToken(), 'tok-2', 'the skew boundary triggers a refresh');
        assert.equal(calls.length, 2);
        assert.equal(verifiedClaims(calls[1]).iat, Math.floor(clock / 1000), 'the refresh re-signs at the current clock');
    } finally {
        restore();
    }
});

test('service account: a rejected exchange clears the in-flight entry so the next call retries', async () => {
    const restore = isolateAmbientCredentials();
    try {
        let attempt = 0;
        const { fetch, calls } = recorder(() => {
            attempt += 1;
            return attempt === 1
                ? new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }), { status: 400 })
                : tokenResponse({ accessToken: 'recovered' });
        });
        const auth = createGoogleAuth({ credentials: serviceAccount(), fetch, now: () => 0 });
        await assert.rejects(auth.getToken(), /Google token request failed with HTTP 400: invalid_grant/);
        assert.equal(await auth.getToken(), 'recovered');
        assert.equal(calls.length, 2);
    } finally {
        restore();
    }
});

test('a token endpoint that never answers rejects on its own deadline and does not wedge the instance', async () => {
    const restore = isolateAmbientCredentials();
    process.env.MERCI_LIMIT_GOOGLE_TOKEN_TIMEOUT_MS = '1200';
    try {
        let endpointHangs = true;
        const { fetch, calls } = recorder(() => (endpointHangs
            ? /** @type {Promise<Response>} */ (new Promise(() => {}))
            : tokenResponse({ accessToken: 'recovered' })));
        const auth = createGoogleAuth({ credentials: serviceAccount(), fetch, now: () => 0 });

        const rejection = await settledWithin({
            promise: auth.getToken().then(() => null, (error) => error),
            ms: 2500,
            label: 'getToken() at a token endpoint that never answers',
        });
        assert.ok(rejection instanceof Error, 'the token call ends on its own deadline');
        assert.match(String(rejection), /timeout/i);

        endpointHangs = false;
        assert.equal(await auth.getToken(), 'recovered', 'the instance recovers once the endpoint answers');
        assert.equal(calls.length, 2, 'exactly one new request after the recovery');
        assert.equal(await auth.getToken(), 'recovered');
        assert.equal(calls.length, 2, 'the recovered token is cached');
    } finally {
        delete process.env.MERCI_LIMIT_GOOGLE_TOKEN_TIMEOUT_MS;
        restore();
    }
});

test('a 307 from the token endpoint is refused and the target is never contacted', async () => {
    const restore = isolateAmbientCredentials();
    const attacker = 'https://attacker.test/collect';
    try {
        let targetHits = 0;
        /** @type {typeof fetch} */
        const fetchStub = async (input, init) => {
            if (String(input) === TOKEN_URL) {
                // The default `redirect: 'follow'` is the leak: the target would
                // receive the signed assertion. A manual request stops here.
                if (init?.redirect !== 'manual') {
                    targetHits += 1;
                    return tokenResponse({ accessToken: 'ya29.secret-value' });
                }
                return new Response(null, { status: 307, headers: { location: `${attacker}/steal?q=1` } });
            }
            targetHits += 1;
            return tokenResponse({ accessToken: 'ya29.secret-value' });
        };
        const auth = createGoogleAuth({ credentials: serviceAccount(), fetch: fetchStub, now: () => 0 });
        await assert.rejects(auth.getToken(), (error) => {
            assert.equal(/** @type {any} */ (error).nonRetryable, true, 'a redirect is refused, not retried');
            assert.ok(String(error).includes(new URL(attacker).origin), `the message names the target origin: ${error}`);
            assert.ok(!String(error).includes('/steal'), 'no target path in the message');
            assert.ok(!String(error).includes('q=1'), 'no target query in the message');
            for (const secret of LEAKED_SECRETS) {
                assert.ok(!String(error).includes(secret), `no message may contain ${secret}: ${error}`);
            }
            return true;
        });
        assert.equal(targetHits, 0, 'the redirect target is never contacted');
    } finally {
        restore();
    }
});

test('a token endpoint that stalls after the headers still ends on its own deadline', async () => {
    const restore = isolateAmbientCredentials();
    process.env.MERCI_LIMIT_GOOGLE_TOKEN_TIMEOUT_MS = '1200';
    try {
        let stalled = true;
        const { fetch, calls } = recorder(() => {
            if (!stalled) return tokenResponse({ accessToken: 'recovered-body' });
            // Headers arrive; the body never sends a byte and never closes.
            return new Response(new ReadableStream({ start() { /* never enqueues */ } }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        const auth = createGoogleAuth({ credentials: serviceAccount(), fetch, now: () => 0 });

        const started = Date.now();
        const rejection = await settledWithin({
            promise: auth.getToken().then(() => null, (error) => error),
            ms: 2500,
            label: 'getToken() at a token body that never arrives',
        });
        assert.ok(rejection instanceof Error, 'the token call ends on its own deadline');
        assert.match(String(rejection), /timeout/i);
        assert.ok(Date.now() - started < 2500, 'the body read is inside the deadline');

        stalled = false;
        assert.equal(await auth.getToken(), 'recovered-body', 'the instance recovers once the body arrives');
        assert.equal(calls.length, 2, 'a new request after the deadline');
    } finally {
        delete process.env.MERCI_LIMIT_GOOGLE_TOKEN_TIMEOUT_MS;
        restore();
    }
});

test('a caller abort stops waiting on the shared request before it answers', async () => {
    const restore = isolateAmbientCredentials();
    try {
        const { fetch, calls } = recorder(async () => {
            await new Promise((resolve) => setTimeout(resolve, 600));
            return tokenResponse({ accessToken: 'late-token' });
        });
        const auth = createGoogleAuth({ credentials: serviceAccount(), fetch, now: () => 0 });
        const controller = new AbortController();
        const reason = new Error('caller cancelled');
        const started = Date.now();
        const pending = auth.getToken({ signal: controller.signal }).then(() => null, (error) => error);
        setTimeout(() => controller.abort(reason), 100);
        const outcome = await settledWithin({ promise: pending, ms: 2000, label: 'getToken() with an aborting caller' });
        const elapsed = Date.now() - started;
        assert.ok(outcome instanceof AbortedError, 'the caller gets its own abort, not the shared answer');
        assert.equal(/** @type {any} */ (outcome).cause, reason);
        assert.ok(elapsed < 500, `the call stops at the caller's abort, not the endpoint (${elapsed}ms)`);

        assert.equal(await auth.getToken(), 'late-token', 'the shared request still completes for the next caller');
        assert.equal(calls.length, 1, 'the abort did not restart the shared request');
    } finally {
        restore();
    }
});

test('the token deadline is a cleared timer, not an AbortSignal.timeout left behind', async () => {
    const restore = isolateAmbientCredentials();
    const original = AbortSignal.timeout;
    try {
        let usedUnclearableTimer = false;
        // AbortSignal.timeout's timer cannot be cleared. The token path must own
        // one it can clear, so seeing the call is enough to prove the change.
        AbortSignal.timeout = () => {
            usedUnclearableTimer = true;
            return new AbortController().signal;
        };
        const { fetch } = recorder(() => tokenResponse());
        const auth = createGoogleAuth({ credentials: serviceAccount(), fetch, now: () => 0 });
        assert.equal(await auth.getToken(), 'ya29.test-token');
        assert.equal(usedUnclearableTimer, false, 'the token deadline is a setTimeout the call clears');
    } finally {
        AbortSignal.timeout = original;
        restore();
    }
});

test('an already-aborted signal is refused before a cached token is served', async () => {
    const restore = isolateAmbientCredentials();
    try {
        const { fetch, calls } = recorder(() => tokenResponse());
        const auth = createGoogleAuth({ credentials: serviceAccount(), fetch, now: () => 0 });
        assert.equal(await auth.getToken(), 'ya29.test-token');

        const controller = new AbortController();
        const reason = new Error('caller cancelled');
        controller.abort(reason);
        await assert.rejects(auth.getAuthHeaders({ signal: controller.signal }), (error) => {
            assert.ok(error instanceof AbortedError);
            assert.equal(/** @type {any} */ (error).cause, reason);
            return true;
        });
        assert.equal(calls.length, 1, 'the cached entry is not served and no request is made');
    } finally {
        restore();
    }
});

test('authorized_user: posts the refresh-token grant', async () => {
    const restore = isolateAmbientCredentials();
    try {
        const { fetch, calls } = recorder(() => tokenResponse({ accessToken: 'user-token' }));
        const auth = createGoogleAuth({
            credentials: {
                type: 'authorized_user',
                client_id: 'id.apps.googleusercontent.com',
                client_secret: 'client-secret',
                refresh_token: '1//refresh-token',
            },
            fetch,
            now: () => 0,
        });
        assert.equal(await auth.getToken(), 'user-token');
        assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)), {
            grant_type: 'refresh_token',
            client_id: 'id.apps.googleusercontent.com',
            client_secret: 'client-secret',
            refresh_token: '1//refresh-token',
        });
        assert.equal(calls[0].url, TOKEN_URL);
        assert.equal(calls[0].method, 'POST');
    } finally {
        restore();
    }
});

test('unsupported credential types name the type and the supported set', async () => {
    for (const type of ['external_account', 'impersonated_service_account', 'gdch_service_account', 'pluggable']) {
        const auth = createGoogleAuth({ credentials: { type, client_email: CLIENT_EMAIL, private_key: privateKeyPem }, fetch: noNetwork });
        await assert.rejects(auth.getToken(), (error) => {
            assert.ok(error instanceof ConfigurationError);
            assert.match(/** @type {Error} */ (error).message, new RegExp(`'${type}'`));
            assert.match(/** @type {Error} */ (error).message, /'service_account'/);
            assert.match(/** @type {Error} */ (error).message, /'authorized_user'/);
            assert.match(/** @type {Error} */ (error).message, /metadata server/);
            return true;
        });
        assert.equal(auth.source, null, 'a rejected resolution leaves source unset');
    }
});

test('authorized_user with a subject is refused as unsupported', async () => {
    const auth = createGoogleAuth({
        credentials: {
            type: 'authorized_user',
            client_id: 'id',
            client_secret: 'secret',
            refresh_token: 'refresh',
            subject: 'admin@example.com',
        },
        fetch: noNetwork,
    });
    await assert.rejects(auth.getToken(), (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(/** @type {Error} */ (error).message, /'authorized_user'.*'subject'/);
        assert.match(/** @type {Error} */ (error).message, /metadata server/);
        return true;
    });
});

test('no credentials: the error names all five sources', async () => {
    const restore = isolateAmbientCredentials();
    try {
        const auth = createGoogleAuth({ fetch: noNetwork });
        assert.equal(auth.source, null);
        await assert.rejects(auth.getToken(), (error) => {
            assert.ok(error instanceof ConfigurationError);
            const { message } = /** @type {Error} */ (error);
            for (const source of ['credentials argument', 'keyFile', 'GOOGLE_APPLICATION_CREDENTIALS', 'well-known ADC file', 'metadata server']) {
                assert.ok(message.includes(source), `the message names ${source}: ${message}`);
            }
            assert.ok(message.includes(join(/** @type {string} */ (process.env.HOME), '.config', 'gcloud', 'application_default_credentials.json')));
            return true;
        });
    } finally {
        restore();
    }
});

test('keyFile: the file is read on first use, not by the factory', async () => {
    const restore = isolateAmbientCredentials();
    const file = tempCredentialFile(serviceAccount());
    try {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = file.path;
        const { fetch, calls } = recorder(() => tokenResponse());
        const auth = createGoogleAuth({ keyFile: file.path, fetch, now: () => 0 });
        assert.equal(auth.source, null);
        assert.equal(calls.length, 0);
        assert.equal(await auth.getToken(), 'ya29.test-token');
        assert.equal(auth.source, 'keyFile', 'keyFile wins over the environment path');
        assert.equal(calls.length, 1);
    } finally {
        restore();
        file.remove();
    }
});

test('a keyFile that does not exist fails on first use, not in the factory', async () => {
    const restore = isolateAmbientCredentials();
    const missing = join(tmpdir(), `merci-google-auth-missing-${process.pid}-${Date.now()}.json`);
    try {
        const auth = createGoogleAuth({ keyFile: missing, fetch: noNetwork });
        assert.equal(auth.source, null, 'the factory does not touch the file system');
        await assert.rejects(auth.getToken(), (error) => {
            assert.ok(error instanceof ConfigurationError);
            const { message } = /** @type {Error} */ (error);
            assert.match(message, /Unable to read/);
            assert.ok(message.includes(missing), `the message names the path: ${message}`);
            return true;
        });
        assert.equal(auth.source, null);
    } finally {
        restore();
    }
});

test('a failed resolution retries on the next call instead of poisoning the instance', async () => {
    const restore = isolateAmbientCredentials();
    const dir = mkdtempSync(join(tmpdir(), 'merci-google-auth-late-'));
    const path = join(dir, 'credential.json');
    try {
        const { fetch, calls } = recorder(() => tokenResponse());
        const auth = createGoogleAuth({ keyFile: path, fetch, now: () => 0 });
        await assert.rejects(auth.getToken(), ConfigurationError);
        assert.equal(auth.source, null, 'a failed resolution leaves source unset');

        writeFileSync(path, JSON.stringify(serviceAccount()), 'utf8');
        assert.equal(await auth.getToken(), 'ya29.test-token', 'the next call resolves again and succeeds');
        assert.equal(auth.source, 'keyFile');
        assert.equal(await auth.getToken(), 'ya29.test-token');
        assert.equal(calls.length, 1, 'the successful resolution and its token are memoised');
    } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('metadata: a failed probe retries on the next call', async () => {
    const restore = isolateAmbientCredentials();
    try {
        process.env.GCE_METADATA_HOST = '127.0.0.1:8125';
        let reachable = false;
        const { fetch, calls } = recorder(({ url }) => {
            if (url.endsWith('/computeMetadata/v1/instance')) {
                if (!reachable) throw new Error('connection refused');
                return new Response('{}', { status: 200 });
            }
            return tokenResponse({ accessToken: 'late-metadata' });
        });
        const auth = createGoogleAuth({ fetch, now: () => 0 });
        await assert.rejects(auth.getToken(), ConfigurationError);
        assert.equal(auth.source, null);

        reachable = true;
        assert.equal(await auth.getToken(), 'late-metadata');
        assert.equal(auth.source, 'metadata');
        assert.equal(await auth.getToken(), 'late-metadata');
        assert.equal(calls.filter((call) => call.url.endsWith('/computeMetadata/v1/instance')).length, 2, 'one probe per attempt');
        assert.equal(calls.filter((call) => call.url.includes('/service-accounts/default/token')).length, 1);
    } finally {
        restore();
    }
});

test('GOOGLE_APPLICATION_CREDENTIALS: the environment path is the third step', async () => {
    const restore = isolateAmbientCredentials();
    const file = tempCredentialFile(serviceAccount());
    try {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = file.path;
        const { fetch, calls } = recorder(() => tokenResponse());
        const auth = createGoogleAuth({ fetch, now: () => 0 });
        assert.equal(auth.source, null);
        assert.equal(await auth.getToken(), 'ya29.test-token');
        assert.equal(auth.source, 'GOOGLE_APPLICATION_CREDENTIALS');
        assert.equal(calls.length, 1);
    } finally {
        restore();
        file.remove();
    }
});

test('credentials win over keyFile', async () => {
    const restore = isolateAmbientCredentials();
    const file = tempCredentialFile({ type: 'authorized_user', client_id: 'id', client_secret: 'secret', refresh_token: 'refresh' });
    try {
        const { fetch } = recorder(() => tokenResponse());
        const auth = createGoogleAuth({ credentials: serviceAccount(), keyFile: file.path, fetch, now: () => 0 });
        await auth.getToken();
        assert.equal(auth.source, 'credentials');
    } finally {
        restore();
        file.remove();
    }
});

test('metadata: the probe is deferred, then sends Metadata-Flavor and the scopes query, and caches', async () => {
    const restore = isolateAmbientCredentials();
    try {
        process.env.GCE_METADATA_HOST = '127.0.0.1:8123';
        const { fetch, calls } = recorder(({ url }) => (url.endsWith('/computeMetadata/v1/instance')
            ? new Response('{}', { status: 200 })
            : tokenResponse({ accessToken: 'metadata-token', expiresIn: 120 })));
        const auth = createGoogleAuth({ fetch, now: () => 0 });
        assert.equal(auth.source, null);
        assert.equal(calls.length, 0, 'no metadata probe before the first token call');

        assert.equal(await auth.getToken(), 'metadata-token');
        assert.equal(auth.source, 'metadata');
        assert.equal(await auth.getToken(), 'metadata-token');

        assert.equal(calls[0].url, 'http://127.0.0.1:8123/computeMetadata/v1/instance');
        const tokenCalls = calls.filter((call) => call.url.includes('/service-accounts/default/token'));
        assert.equal(tokenCalls.length, 1, 'the metadata token is cached');
        assert.equal(tokenCalls[0].headers['metadata-flavor'], 'Google');
        const url = new URL(tokenCalls[0].url);
        assert.equal(url.host, '127.0.0.1:8123');
        assert.equal(url.searchParams.get('scopes'), CLOUD_PLATFORM);
    } finally {
        restore();
    }
});

test('metadata: concurrent first calls share one probe and one token POST', async () => {
    const restore = isolateAmbientCredentials();
    try {
        process.env.GCE_METADATA_HOST = '127.0.0.1:8124';
        /** @type {() => void} */
        let release = () => {};
        const gate = new Promise((resolve) => { release = () => resolve(undefined); });
        const { fetch, calls } = recorder(async ({ url }) => {
            if (url.endsWith('/computeMetadata/v1/instance')) return new Response('{}', { status: 200 });
            await gate;
            return tokenResponse({ accessToken: 'concurrent-metadata' });
        });
        const auth = createGoogleAuth({ fetch, now: () => 0 });
        const first = auth.getToken();
        const second = auth.getToken();
        release();
        assert.deepEqual(await Promise.all([first, second]), ['concurrent-metadata', 'concurrent-metadata']);
        assert.equal(calls.filter((call) => call.url.endsWith('/computeMetadata/v1/instance')).length, 1);
        assert.equal(calls.filter((call) => call.url.includes('/service-accounts/default/token')).length, 1);
        assert.equal(auth.source, 'metadata');
    } finally {
        restore();
    }
});

test('a malformed token body never leaks the body, the token or the key', async () => {
    const restore = isolateAmbientCredentials();
    try {
        // The shape V8 echoes back in a parse error: an unquoted value.
        const leakyBody = `{"access_token":ya29.secret-value,"private_key":MIIEowIBAA`;
        const { fetch } = recorder(() => new Response(leakyBody, { status: 200 }));
        const auth = createGoogleAuth({ credentials: serviceAccount(), fetch, now: () => 0 });
        await assert.rejects(auth.getToken(), (error) => {
            const messages = causeChainMessages(error).join('\n');
            assert.match(messages, /not valid JSON/);
            for (const secret of LEAKED_SECRETS) {
                assert.ok(!messages.includes(secret), `no message in the cause chain may contain ${secret}: ${messages}`);
            }
            return true;
        });
    } finally {
        restore();
    }
});

test('a malformed credential file never quotes the JSON it could not parse', async () => {
    const restore = isolateAmbientCredentials();
    const dir = mkdtempSync(join(tmpdir(), 'merci-google-auth-bad-'));
    const path = join(dir, 'credential.json');
    // Unquoted, so the parser's own message would echo the key material back.
    writeFileSync(path, `{"type":"service_account","private_key":MIIEowIBAA`, 'utf8');
    try {
        const auth = createGoogleAuth({ keyFile: path, fetch: noNetwork });
        await assert.rejects(auth.getToken(), (error) => {
            assert.ok(error instanceof ConfigurationError);
            const messages = causeChainMessages(error).join('\n');
            assert.match(messages, /is not valid JSON/);
            assert.ok(messages.includes(path), `the message names the path: ${messages}`);
            for (const secret of LEAKED_SECRETS) {
                assert.ok(!messages.includes(secret), `no message in the cause chain may contain ${secret}: ${messages}`);
            }
            assert.equal(/** @type {any} */ (error).cause, undefined, 'the parser error is dropped, not chained');
            return true;
        });
    } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('neither parse failure keeps the parser error in its cause chain', async () => {
    const restore = isolateAmbientCredentials();
    const dir = mkdtempSync(join(tmpdir(), 'merci-google-auth-chain-'));
    const path = join(dir, 'credential.json');
    writeFileSync(path, '{"type":"service_account","private_key":MIIEowIBAA', 'utf8');
    try {
        const fileError = await createGoogleAuth({ keyFile: path, fetch: noNetwork }).getToken().then(() => null, (error) => error);
        const { fetch } = recorder(() => new Response('{"access_token":ya29.secret-value}', { status: 200 }));
        const bodyError = await createGoogleAuth({ credentials: serviceAccount(), fetch, now: () => 0 })
            .getToken().then(() => null, (error) => error);
        for (const [name, error] of [['credential file', fileError], ['token body', bodyError]]) {
            assert.ok(error instanceof Error, `${name}: rejected`);
            // One message, the wrapper's own: the parser error and the text it
            // echoed are gone, not merely hidden from `message`.
            assert.equal(causeChainMessages(error).length, 1, `${name}: no parser error is chained`);
        }
    } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a token response without a string access_token names only its keys', async () => {
    const restore = isolateAmbientCredentials();
    try {
        const { fetch } = recorder(() => new Response(JSON.stringify({ expires_in: 3600, token_type: 'Bearer' }), { status: 200 }));
        const auth = createGoogleAuth({ credentials: serviceAccount(), fetch, now: () => 0 });
        await assert.rejects(auth.getToken(), /missing a string access_token \(keys: expires_in, token_type\)/);
    } finally {
        restore();
    }
});

test('a response without token_type falls back to Bearer', async () => {
    const restore = isolateAmbientCredentials();
    try {
        const { fetch } = recorder(() => new Response(JSON.stringify({ access_token: 'untyped', expires_in: 3600 }), { status: 200 }));
        const auth = createGoogleAuth({ credentials: serviceAccount(), fetch, now: () => 0 });
        assert.equal((await auth.getAuthHeaders()).get('authorization'), 'Bearer untyped');
    } finally {
        restore();
    }
});

test('scopes: a set without cloud-platform is refused before any request', () => {
    assert.throws(
        () => createGoogleAuth({ credentials: serviceAccount(), scopes: ['https://www.googleapis.com/auth/drive'], fetch: noNetwork }),
        (error) => {
            assert.ok(error instanceof ConfigurationError);
            assert.match(/** @type {Error} */ (error).message, /cloud-platform/);
            return true;
        },
    );
});

test('scopes: a supplied set must be a non-empty array of strings', () => {
    for (const scopes of [[], ['ok', 5], 'cloud-platform']) {
        assert.throws(
            () => createGoogleAuth({ credentials: serviceAccount(), scopes: /** @type {any} */ (scopes), fetch: noNetwork }),
            ConfigurationError,
        );
    }
});
