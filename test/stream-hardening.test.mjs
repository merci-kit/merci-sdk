// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSSELines, SSEParser } from '../lib/backends/jai-vendor/sse-parser.mjs';
import { ChatSession as JaiVendorChatSession } from '../lib/backends/jai-vendor/chat-session.mjs';
import { InactivityTimeoutPolicy } from '../lib/support/stream-timeout.mjs';
import { retryDelayMs, sleepAbortable, InternalHttpClient, jwtExpiresAt } from '../lib/backends/jai-vendor/http-client.mjs';
import { jaiAdapter } from '../lib/backends/adapters/jai-adapter.mjs';
import { gaiAdapter } from '../lib/backends/adapters/gai-adapter.mjs';
import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';
import { createOaiTransport } from '../lib/backends/transport/oai-client.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

/**
 * @param {{expSeconds: number}} arg0
 */
function makeJwt({ expSeconds }) {
    const header = Buffer.from(JSON.stringify({ alg: 'none' }), 'utf8').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: expSeconds }), 'utf8').toString('base64url');
    return `${header}.${payload}.sig`;
}

/**
 * @param {{bodyText: string}} arg0
 */
function okResponse({ bodyText }) {
    return {
        ok: true, status: 200,
        headers: {},
        body: Readable.from([Buffer.from(bodyText)]),
        json: async () => JSON.parse(bodyText)
    };
}

/**
 * @param {{chunks: string[]}} arg0
 */
function streamFrom({ chunks }) {
    return Readable.from(chunks.map(c => Buffer.from(c)));
}

describe('SSE error masking (C1)', () => {
    it('a mid-JSON error propagates the original error, not a parse error', async () => {
        const boom = new Error('network drop');
        boom.name = 'AbortError';
        const bad = {
            async *[Symbol.asyncIterator]() {
                yield 'data: {"type":"text","content":"partial';
                throw boom;
            }
        };
        await assert.rejects(
            async () => { for await (const _ of readSSELines({ stream: bad, parser: new SSEParser() })) {} },
            (err) => err === boom,
            'must rethrow the original stream error'
        );
    });

    it('a clean end still flushes the final buffer line', async () => {
        const events = [];
        for await (const e of readSSELines({ stream: streamFrom({ chunks: ['data: {"type":"Content","content":"final"}'] }), parser: new SSEParser() })) events.push(e);
        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'text');
        assert.equal(events[0].content, 'final');
    });
});

describe('timeout aborts the vendor request (C3)', () => {
    it('wrapStream calls onTimeoutAbort with the timeout error', async () => {
        const policy = new InactivityTimeoutPolicy({ timeoutMs: 20 });
        const stalled = {
            async *[Symbol.asyncIterator]() {
                await new Promise(() => {});
            }
        };
        let abortedWith = /** @type {any} */ (null);
        /** @param {{err: *}} arg0 */
        const wrapped = policy.wrapStream({ stream: stalled, signal: null, onTimeoutAbort: /** @type {(...args: any[]) => any} */ (({ err }) => { abortedWith = err; }) });
        const it = wrapped[Symbol.asyncIterator]();
        await assert.rejects(() => it.next(), (err) => (/** @type {any} */ (err)).name === 'AbortError');
        assert.ok(abortedWith, 'onTimeoutAbort must fire');
        assert.match(abortedWith.message, /timeout/);
        await it.return?.();
    });

    it('sleepAbortable rejects immediately on a pre-aborted signal', async () => {
        const ac = new AbortController();
        ac.abort(new Error('cancelled'));
        await assert.rejects(
            sleepAbortable({ ms: 1000, signal: ac.signal }),
            (e) => (/** @type {any} */ (e)).name === 'AbortedError' && (/** @type {any} */ (e)).cause?.message === 'cancelled'
        );
    });
});

describe('Retry-After parsing (M5)', () => {
    it('seconds form is used directly', () => {
        assert.equal(retryDelayMs({ retryAfter: '2', fallbackMs: 1000 }), 2000);
    });
    it('HTTP-date form yields the delta, capped at 60s', () => {
        // `toUTCString` truncates to a whole second, so `Date.now() + 5000`
        // can lose up to 999 ms and land just below the lower bound. Anchor to
        // the next whole second instead: the delta stays 5–6 s regardless of
        // where in the current second the test runs.
        const future = new Date((Math.floor(Date.now() / 1000) + 6) * 1000).toUTCString();
        const d = retryDelayMs({ retryAfter: future, fallbackMs: 1000 });
        assert.ok(d >= 4000 && d <= 60000, `expected ~5000ms, got ${d}`);
    });
    it('garbage falls back to the exponential default', () => {
        assert.equal(retryDelayMs({ retryAfter: 'not-a-date', fallbackMs: 4000 }), 4000);
    });
});

describe('JAI transport hardening', () => {
    it('APIStatusError preserves the server-provided message', async () => {
        const real = globalThis.fetch;
        try {
            globalThis.fetch = /** @type {any} */ (async () => ({
                ok: false, status: 429,
                headers: { get: () => null },
                text: async () => JSON.stringify({ message: 'Quota exhausted for profile' })
            }));
            const c = new InternalHttpClient({ options: { token: 't' }, eventEmitter: new EventEmitter() });
            await assert.rejects(
                c._fetchWithRetry({ path: '/llm/chat/stream/v9', options: { method: 'POST', body: '{}' } }),
                /Quota exhausted for profile/
            );
        } finally { globalThis.fetch = real; }
    });

    it('bodyTimeoutMs aborts a response whose body never arrives', async () => {
        const real = globalThis.fetch;
        try {
            let aborted = null;
            globalThis.fetch = /** @type {(input: any, init?: any) => Promise<any>} */ (async (_url, opts) => {
                (/** @type {any} */ (opts)).signal.addEventListener('abort', () => { aborted = opts.signal.reason; });
                const body = new ReadableStream({
                    start(controller) {
                        (/** @type {any} */ (opts)).signal.addEventListener('abort', () => controller.error(opts.signal.reason));
                    }
                });
                return new Promise((resolve) => {
                    setTimeout(() => resolve(new Response(body)), 0);
                });
            });
            const c = new InternalHttpClient({ options: { token: 't' }, eventEmitter: new EventEmitter() });
            const response = await c._fetchWithRetry({ path: '/llm/profiles/v9', options: { method: 'GET', bodyTimeoutMs: 50 } });
            await assert.rejects(
                response.json(),
                /body within 50ms/
            );
            assert.ok(aborted, 'the fetch signal must be aborted by the body deadline');
        } finally { globalThis.fetch = real; }
    });

    it('api_response headers are redacted on the observable emitter (no JWT echo)', async () => {
        const real = globalThis.fetch;
        try {
            globalThis.fetch = /** @type {any} */ (async () => ({
                ok: true, status: 200,
                headers: new Headers({ 'Grazie-Authenticate-JWT': 'super-secret-jwt' }),
                body: Readable.from([Buffer.from('{}')])
            }));
            const emitter = new EventEmitter();
            const c = new InternalHttpClient({ options: { token: 't' }, eventEmitter: emitter });
            let captured = /** @type {any} */ (null);
            emitter.on('api_response', (m) => { captured = m; });
            await c._fetchWithRetry({ path: '/llm/profiles/v9', options: { method: 'GET' } });
            assert.ok(captured, 'api_response must be emitted');
            assert.equal(captured.headers['grazie-authenticate-jwt'], '[REDACTED]',
                'response headers echoing auth values must be redacted on the observable surface');
        } finally { globalThis.fetch = real; }
    });

    it('JAI executeVendorRequest surfaces fetch failures to the retry policy', async () => {
        let fetchAttempts = 0;
        const real = globalThis.fetch;
        try {
            globalThis.fetch = async () => {
                fetchAttempts++;
                if (fetchAttempts === 1) {
                    throw new Error('transient network failure');
                }
                const body = new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('data: {"type":"Content","content":"recovered"}\n'));
                        controller.enqueue(new TextEncoder().encode('data: {"type":"FinishMetadata","reason":"stop"}\n'));
                        controller.close();
                    }
                });
                return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
            };
            const emitter = new EventEmitter();
            const httpClient = new InternalHttpClient({ options: { token: 't' }, eventEmitter: emitter });
            const profileManager = /** @type {any} */ ({ getProfiles: async () => {} });
            const { ChatSession } = await import('../lib/backends/jai-vendor/chat-session.mjs');
            const session = new ChatSession({ httpClient, profile: 'jai-gpt-4o', profileManager });

            /** @param {{attempt: *}} arg0 */
            const decision = { shouldRetry: /** @type {(params: { error: any, attempt: number }) => any} */ (({ attempt }) => attempt < 2 ? { retry: true, delayMs: 1 } : null) };
            let attempts = 0;
            let raw;
            while (true) {
                try {
                    raw = await (/** @type {any} */ (jaiAdapter)).executeVendorRequest({ vendorClient: httpClient, request: { session, messages: [{ type: 'user_message', content: 'hi' }] }, signal: null });
                    break;
                } catch (err) {
                    attempts++;
                    const d = decision.shouldRetry({ error: err, attempt: attempts });
                    if (!d) throw err;
                }
            }
            const events = [];
            for await (const e of raw) events.push(e);
            assert.equal(fetchAttempts, 2, 'the retry loop must fire on the transport fetch failure');
            assert.ok(events.some(e => e.type === 'text' && e.content === 'recovered'));
        } finally { globalThis.fetch = real; }
    });
});

describe('proactive token refresh + persistence', () => {
    it('jwtExpiresAt decodes exp only from valid JWTs', () => {
        assert.equal(jwtExpiresAt({ token: makeJwt({ expSeconds: 1_700_000_000 }) }), 1_700_000_000_000);
        assert.equal(jwtExpiresAt({ token: 'plain-token' }), null);
        assert.equal(jwtExpiresAt({ token: 'a.b' }), null);
        assert.equal(jwtExpiresAt({ token: 'x.{"nope":1}.sig' }), null);
        assert.equal(jwtExpiresAt({ token: '' }), null);
        assert.equal(jwtExpiresAt({ token: /** @type {any} */ (null) }), null);
    });

    it('an expired JWT is refreshed BEFORE the request leaves — no 401 on the wire', async () => {
        const real = globalThis.fetch;
        try {
            const wire = /** @type {any[]} */ ([]);
            const fresh = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
            globalThis.fetch = /** @type {(input: any, init?: any) => Promise<any>} */ (async (url, opts) => {
                wire.push({ url: String(url), status: 200, token: opts.headers['Grazie-Authenticate-JWT'] });
                if (String(url).includes('/auth/jwt/refresh/v3')) {
                    return { ok: true, status: 200, json: async () => ({ token: fresh }) };
                }
                return okResponse({ bodyText: JSON.stringify({ profiles: [] }) });
            });
            const c = new InternalHttpClient({ options: { token: makeJwt({ expSeconds: Math.floor(Date.now() / 1000) - 3600 }) }, eventEmitter: new EventEmitter() });
            const response = await c._fetchWithRetry({ path: '/llm/profiles/v9', options: { method: 'GET' } });
            await response.json();
            assert.equal(wire.length, 2, 'refresh + profiles request, nothing else');
            assert.match(wire[0].url, /auth\/jwt\/refresh\/v3$/, 'first wire call must be the refresh');
            assert.match(wire[1].url, /llm\/profiles\/v9$/, 'profiles fetch comes second');
            assert.equal(wire[1].token, fresh, 'profiles request must carry the fresh token');
            assert.ok(wire.every((w) => w.status !== 401), 'no 401 response may appear on the wire');
        } finally { globalThis.fetch = real; }
    });

    it('a valid JWT is not refreshed — single request with the original token', async () => {
        const real = globalThis.fetch;
        try {
            const wire = /** @type {any[]} */ ([]);
            const token = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 7200 });
            globalThis.fetch = /** @type {(input: any, init?: any) => Promise<any>} */ (async (url, opts) => {
                wire.push({ url: String(url), token: opts.headers['Grazie-Authenticate-JWT'] });
                return okResponse({ bodyText: JSON.stringify({ profiles: [] }) });
            });
            const c = new InternalHttpClient({ options: { token }, eventEmitter: new EventEmitter() });
            await c._fetchWithRetry({ path: '/llm/profiles/v9', options: { method: 'GET' } });
            assert.equal(wire.length, 1, 'no refresh call for a valid token');
            assert.equal(wire[0].token, token, 'original token must be used unchanged');
        } finally { globalThis.fetch = real; }
    });

    it('an opaque (non-JWT) token skips proactive refresh — reactive 401 path still covers it', async () => {
        const real = globalThis.fetch;
        try {
            const wire = /** @type {any[]} */ ([]);
            globalThis.fetch = /** @type {(input: any, init?: any) => Promise<any>} */ (async (url, opts) => {
                wire.push({ url: String(url), token: opts.headers['Grazie-Authenticate-JWT'] });
                return okResponse({ bodyText: JSON.stringify({ profiles: [] }) });
            });
            const c = new InternalHttpClient({ options: { token: 'opaque-token' }, eventEmitter: new EventEmitter() });
            await c._fetchWithRetry({ path: '/llm/profiles/v9', options: { method: 'GET' } });
            assert.equal(wire.length, 1);
            assert.equal(wire[0].token, 'opaque-token');
        } finally { globalThis.fetch = real; }
    });

    it('a failing proactive refresh rejects the request and emits token_refresh_failure exactly once', async () => {
        const real = globalThis.fetch;
        try {
            globalThis.fetch = async () => { throw new Error('network down'); };
            const emitter = new EventEmitter();
            const failures = [];
            emitter.on('token_refresh_failure', (m) => failures.push(m));
            const c = new InternalHttpClient({ options: { token: makeJwt({ expSeconds: Math.floor(Date.now() / 1000) - 3600 }) }, eventEmitter: emitter });
            const results = await Promise.allSettled([
                c._fetchWithRetry({ path: '/llm/profiles/v9', options: { method: 'GET' } }),
                c._fetchWithRetry({ path: '/llm/profiles/v9', options: { method: 'GET' } })
            ]);
            assert.ok(results.every((r) => r.status === 'rejected' && /network down/.test(r.reason?.message)),
                'both concurrent callers must surface the refresh failure');
            assert.equal(failures.length, 1, 'concurrent waiters sharing one failed refresh must still report it exactly once');
        } finally { globalThis.fetch = real; }
    });

    it('refreshToken persists the new token to the configured file+key, preserving other lines', async () => {
        const real = globalThis.fetch;
        const dir = await mkdtemp(join(tmpdir(), 'merci-persist-'));
        try {
            const file = join(dir, 'secret.env');
            await writeFile(file, 'A=1\nJAI_TOKEN=old\nB=2\n');
            const fresh = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
            globalThis.fetch = /** @type {(input: any, init?: any) => Promise<any>} */ (async (url) => {
                if (String(url).includes('/auth/jwt/refresh/v3')) {
                    return { ok: true, status: 200, json: async () => ({ token: fresh }) };
                }
                throw new Error('unexpected wire call');
            });
            const c = new InternalHttpClient({ options: { token: 'expired', tokenPersistFile: file, tokenPersistKey: 'JAI_TOKEN' }, eventEmitter: new EventEmitter() });
            assert.equal(await c.refreshToken(), fresh);
            assert.equal(await readFile(file, 'utf8'), `A=1\nJAI_TOKEN=${fresh}\nB=2\n`);
        } finally {
            globalThis.fetch = real;
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('persistence preserves an existing file mode and defaults new files to 0600', async () => {
        const real = globalThis.fetch;
        const dir = await mkdtemp(join(tmpdir(), 'merci-persist-'));
        try {
            const existingFile = join(dir, '0640.env');
            await writeFile(existingFile, 'JAI_TOKEN=old\n', { mode: 0o640 });
            const newFile = join(dir, 'fresh.env');
            const fresh = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
            globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, status: 200, json: async () => ({ token: fresh }) }));
            const c1 = new InternalHttpClient({ options: { token: 'expired', tokenPersistFile: existingFile, tokenPersistKey: 'JAI_TOKEN' }, eventEmitter: new EventEmitter() });
            await c1.refreshToken();
            const c2 = new InternalHttpClient({ options: { token: 'expired', tokenPersistFile: newFile, tokenPersistKey: 'JAI_TOKEN' }, eventEmitter: new EventEmitter() });
            await c2.refreshToken();
            assert.equal((await stat(existingFile)).mode & 0o777, 0o640, 'rename must not loosen an existing restrictive mode');
            assert.equal((await stat(newFile)).mode & 0o777, 0o600, 'a fresh secrets file must default to 0600');
        } finally {
            globalThis.fetch = real;
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('persistence appends a missing key and tolerates write failures', async () => {
        const real = globalThis.fetch;
        const dir = await mkdtemp(join(tmpdir(), 'merci-persist-'));
        try {
            const file = join(dir, 'other.env');
            await writeFile(file, 'C=3\n');
            const fresh = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
            globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, status: 200, json: async () => ({ token: fresh }) }));
            const c = new InternalHttpClient({ options: { token: 'expired', tokenPersistFile: file, tokenPersistKey: 'JAI_TOKEN' }, eventEmitter: new EventEmitter() });
            await c.refreshToken();
            assert.equal(await readFile(file, 'utf8'), `C=3\nJAI_TOKEN=${fresh}`);

            const bad = new InternalHttpClient({ options: { token: 'expired', tokenPersistFile: join(dir, 'no-such-dir', 'secret.env'), tokenPersistKey: 'JAI_TOKEN' }, eventEmitter: new EventEmitter() });
            assert.equal(await bad.refreshToken(), fresh, 'a failed persist write must not fail the refresh');
        } finally {
            globalThis.fetch = real;
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('finishReason surfacing (M3)', () => {
    it('GAI SAFETY finish emits an error event', async () => {
        const events = [];
        for await (const e of (/** @type {any} */ (gaiAdapter)).consumeStream({ rawStream: [
            { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }
        ] })) events.push(e);
        assert.ok(events.some(e => e.type === 'error' && e.error_type === 'SAFETY'));
    });

    it('GAI normal STOP emits no error event', async () => {
        const events = [];
        for await (const e of (/** @type {any} */ (gaiAdapter)).consumeStream({ rawStream: [
            { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hi' }] } }] }
        ] })) events.push(e);
        assert.ok(!events.some(e => e.type === 'error'));
    });

    it('OAI content_filter finish emits one error event', async () => {
        const events = [];
        for await (const e of (/** @type {any} */ (oaiAdapter)).consumeStream({ rawStream: [
            { choices: [{ delta: { content: 'partial' }, finish_reason: 'content_filter' }] },
            { choices: [{ delta: {}, finish_reason: 'content_filter' }] }
        ] })) events.push(e);
        assert.equal(events.filter(e => e.type === 'error').length, 1);
    });

    it('OAI tool_calls finish emits NO error event (normal tool round)', async () => {
        const events = [];
        for await (const e of (/** @type {any} */ (oaiAdapter)).consumeStream({ rawStream: [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
        ] })) events.push(e);
        assert.ok(!events.some(e => e.type === 'error'), 'tool_calls is a normal terminal reason');
        assert.ok(events.some(e => e.type === 'tool_calls'));
    });

    it('OAI stop finish emits no error event', async () => {
        const events = [];
        for await (const e of (/** @type {any} */ (oaiAdapter)).consumeStream({ rawStream: [
            { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
        ] })) events.push(e);
        assert.ok(!events.some(e => e.type === 'error'));
    });
});

describe('JAI premature-end transport retry', () => {
    /** @param {string[]} chunks */
    /** @param {{chunks: *}} arg0 */
    const webStream = ({ chunks }) => new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
            controller.close();
        }
    });

    /** @param {{t: *}} arg0 */
    const content = ({ t }) => `data: ${JSON.stringify({ type: 'Content', content: t })}\n`;
    const premature = 'data: {"type":"PrematureEnd","reason":"Unknown"}\n';
    const finish = 'data: {"type":"FinishMetadata","reason":"stop"}\n';

    /**
 * @param {{attempts: string[][]}} arg0
 */
    function makeRetryClient({ attempts }) {
        let calls = 0;
        return {
            count: () => calls,
            streamTimeout: 1000,
            _fetchWithRetry: async () => {
                const chunks = attempts[Math.min(calls, attempts.length - 1)];
                calls++;
                return { body: webStream({ chunks }) };
            },
            getEventEmitter: () => new EventEmitter(),
        };
    }

    /** @param {any} session */
    /** @param {{session: *}} arg0 */
    const drainStream = async ({ session }) => {
        const events = [];
        for await (const e of session.stream({ initialInput: [{ type: 'user_message', content: 'go' }] })) events.push(e);
        return events;
    };

    it('retries a premature end and yields the replacement stream, marking a restart', async () => {
        const http = makeRetryClient({ attempts: [
            [content({ t: 'partial' }), premature],
            [content({ t: 'complete' }), finish],
        ] });
        const session = new JaiVendorChatSession({ httpClient: /** @type {any} */ (http), profile: 'jai-gemini', profileManager: null });
        const events = await drainStream({ session });
        assert.equal(http.count(), 2, 'the premature end retried once');
        assert.deepEqual(events.map((e) => e.type), ['text', 'restart', 'text', 'finish']);
        assert.equal(events[0].content, 'partial');
        assert.equal(events[2].content, 'complete');
        assert.equal(events.some((e) => e.type === 'premature_end'), false,
            'a recovered attempt never stamps the turn truncated');
    });

    it('retries an empty premature end without a restart (nothing was yielded)', async () => {
        const http = makeRetryClient({ attempts: [
            [premature],
            [content({ t: 'complete' }), finish],
        ] });
        const session = new JaiVendorChatSession({ httpClient: /** @type {any} */ (http), profile: 'jai-gemini', profileManager: null });
        const events = await drainStream({ session });
        assert.equal(http.count(), 2);
        assert.deepEqual(events.map((e) => e.type), ['text', 'finish']);
    });

    it('surfaces the marker once when every attempt is cut short', async () => {
        const http = makeRetryClient({ attempts: [[premature]] });
        const session = new JaiVendorChatSession({ httpClient: /** @type {any} */ (http), profile: 'jai-gemini', profileManager: null });
        const events = await drainStream({ session });
        assert.equal(http.count(), 3, '1 attempt + 2 retries');
        assert.equal(events.filter((e) => e.type === 'premature_end').length, 1,
            'the marker is yielded exactly once, on the final attempt');
    });

    it('backs off (abortably) between premature-end retries instead of retrying immediately', async () => {
        const http = makeRetryClient({ attempts: [[premature]] });
        const session = new JaiVendorChatSession({ httpClient: /** @type {any} */ (http), profile: 'jai-gemini', profileManager: null });
        const startedAt = Date.now();
        const events = await drainStream({ session });
        const elapsed = Date.now() - startedAt;
        assert.equal(http.count(), 3);
        assert.equal(events.filter((e) => e.type === 'premature_end').length, 1);
        assert.ok(elapsed >= 1000, `expected >=1000ms of backoff between 3 attempts, saw ${elapsed}ms`);
    });
});

describe('streamState survives the timeout wrapper', () => {
    it('copies the source object onto the wrapped generator by identity, non-enumerably', async () => {
        /** @type {{sawDone: boolean}} */
        const state = { sawDone: false };
        const source = (async function* () { yield 'a'; })();
        Object.defineProperty(source, 'streamState', { value: state, enumerable: false });
        const wrapped = new InactivityTimeoutPolicy({ timeoutMs: 1000 }).wrapStream({ stream: source });
        assert.equal(/** @type {any} */ (wrapped).streamState, state, 'the same object rides along');
        assert.equal(Object.getOwnPropertyDescriptor(wrapped, 'streamState')?.enumerable, false, 'the property stays non-enumerable');
        for await (const _ of wrapped) { /* drain */ }
    });

    /**
     * A session whose adapter opens a real transport stream over a stub fetch.
     * @param {{body: string}} arg0
     */
    function makeSession({ body }) {
        const transport = createOaiTransport({
            apiKey: 'k',
            baseURL: 'https://gateway.test/v1',
            fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        });
        const adapter = {
            vendorName: 'OAI',
            buildVendorRequest: () => ({ request: { model: 'm', stream: true }, observability: {} }),
            executeVendorRequest: () => transport.chat.completions.create({ model: 'm', stream: true }),
            /** @param {{rawStream: *, signal: *}} arg0 */
            consumeStream: ({ rawStream, signal }) => oaiAdapter.consumeStream({ rawStream, signal }),
            extractXmlToolCalls: () => [],
            /** @param {{call: *}} arg0 */
            formatToolCall: ({ call }) => ({ id: call.id, name: call.name, args: call.args }),
        };
        return new (class extends AbstractChatSession {
            /** @param {*} arg0 */
            constructor(arg0) {
                super(arg0);
                this._adapter = adapter;
            }
        })({ provider: ProviderType.OPENAI, model: 'm', eventEmitter: new EventEmitter(), client: null, vendorClient: {}, retryPolicy: null });
    }

    /** @param {{body: string}} arg0 */
    async function runStep({ body }) {
        const session = makeSession({ body });
        /** @type {Array<any>} */
        const events = [];
        const gen = session.step({ messages: [{ type: 'user_message', role: 'user', content: 'ping' }] });
        let r = await gen.next();
        while (!r.done) { events.push(r.value); r = await gen.next(); }
        return { events, state: /** @type {any} */ (r.value) };
    }

    it('a [DONE] stream without finish_reason is not truncated through step()', async () => {
        const { events, state } = await runStep({
            body: 'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
        });
        assert.equal(events.some((e) => e.type === 'truncated'), false, 'the sentinel is terminal');
        assert.equal(Boolean(state.truncated), false);
        assert.equal(events.filter((e) => e.type === 'text').map((e) => e.content).join(''), 'hi');
    });

    it('a stream with neither [DONE] nor a finish_reason is truncated through step()', async () => {
        const { events, state } = await runStep({
            body: 'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
        });
        assert.equal(state.truncated, true, 'the step records the truncation');
        assert.equal(events.filter((e) => e.type === 'text').map((e) => e.content).join(''), 'hi');
    });
});
