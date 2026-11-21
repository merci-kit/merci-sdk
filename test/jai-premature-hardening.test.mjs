// @ts-check
/**
 * JAI premature-end hardening: no retry on moderation or a deterministic cut,
 * diagnostics (trace id, message, event type) carried to the consumer, and a
 * clean EOF without FinishMetadata treated as a truncation.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { ChatSession } from '../lib/backends/jai-vendor/chat-session.mjs';
import { InternalHttpClient } from '../lib/backends/jai-vendor/http-client.mjs';
import { SSEParser } from '../lib/backends/jai-vendor/sse-parser.mjs';
import { MerciClient } from '../lib/backends/jai.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { LIMITS } from '../lib/core/limit-config.mjs';
import { TRUNCATION_MARKER } from '../lib/core/constants/limits/transport.mjs';

/** @param {string[]} chunks */
/** @param {{chunks: *}} arg0 */
const webStream = ({ chunks }) => new ReadableStream({
    start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
    }
});

/** @param {{t: string}} arg0 */
const content = ({ t }) => `data: ${JSON.stringify({ type: 'Content', content: t })}\n`;
const finish = 'data: {"type":"FinishMetadata","reason":"stop"}\n';

/**
 * @param {{attempts: string[][], headers?: Record<string, string>}} arg0
 */
function makeClient({ attempts, headers = {} }) {
    let calls = 0;
    const emitter = new EventEmitter();
    const warnings = /** @type {any[]} */ ([]);
    emitter.on(EVENTS.CLIENT.WARNING, (/** @type {any} */ e) => warnings.push(e));
    return {
        count: () => calls,
        warnings,
        emitter,
        streamTimeout: 1000,
        getEventEmitter: () => emitter,
        _fetchWithRetry: async () => {
            const chunks = attempts[Math.min(calls, attempts.length - 1)];
            calls++;
            return { headers: { get: (/** @type {string} */ name) => headers[name.toLowerCase()] ?? null }, body: webStream({ chunks }) };
        },
    };
}

/** @param {{http: *, profile?: string}} arg0 */
function makeSession({ http, profile = 'jai-gemini' }) {
    return new ChatSession({ httpClient: /** @type {any} */ (http), profile, profileManager: null });
}

/** @param {{session: *, http: *}} arg0 @returns {Promise<any[]>} */
async function drain({ session, http }) {
    const events = [];
    const runContext = { emit: (/** @type {any} */ { emitter, name, payload }) => emitter?.emit(name, payload) };
    for await (const e of session.stream({ initialInput: [{ type: 'user_message', content: 'go' }], options: { runContext } })) events.push(e);
    return events;
}

describe('JAI premature end: retry policy', () => {
    it('does not retry a content_filter stop', async () => {
        const http = makeClient({ attempts: [[content({ t: 'bad' }), 'data: {"type":"PrematureEnd","reason":"content_filter"}\n']] });
        const events = await drain({ session: makeSession({ http }), http });
        assert.equal(http.count(), 1, 'moderation is deterministic; the same request is not re-sent');
        assert.deepEqual(events.map((e) => e.type), ['text', 'premature_end']);
        assert.equal(events[1].reason, 'content_filter');
        assert.ok(http.warnings.some((w) => w.code === 'STREAM_PREMATURE_NO_RETRY'), 'the no-retry decision is explained');
    });

    it('stops after a second identical cut instead of buying the same answer again', async () => {
        const premature = 'data: {"type":"PrematureEnd","reason":"Unknown"}\n';
        const http = makeClient({ attempts: [[content({ t: 'partial' }), premature]] });
        const events = await drain({ session: makeSession({ http }), http });
        assert.equal(http.count(), 2, 'one retry, then the deterministic cut is recognised');
        assert.deepEqual(events.map((e) => e.type), ['text', 'restart', 'text', 'premature_end']);
        assert.ok(http.warnings.some((w) => w.code === 'STREAM_PREMATURE_NO_RETRY' && /deterministic/.test(w.message)));
    });

    it('does not treat two empty cuts as deterministic content cuts', async () => {
        const premature = 'data: {"type":"PrematureEnd","reason":"Unknown"}\n';
        const http = makeClient({ attempts: [[premature]] });
        const events = await drain({ session: makeSession({ http }), http });
        assert.equal(http.count(), 3, 'nothing was yielded, so the normal attempt budget still applies');
        assert.equal(events.filter((e) => e.type === 'premature_end').length, 1);
    });
});

describe('JAI premature end: diagnostics', () => {
    it('bounds message and event_type and marks a cut diagnostic', () => {
        const long = 'x'.repeat(LIMITS.max_error_message_chars + 10);
        const event = new SSEParser({}).parseLine({ line: `data: ${JSON.stringify({ type: 'PrematureEnd', reason: 'Unknown', message: long, event_type: long })}` });
        assert.ok(event?.message?.endsWith(TRUNCATION_MARKER));
        assert.equal(event?.message?.length, LIMITS.max_error_message_chars + TRUNCATION_MARKER.length);
        assert.ok(event?.eventType?.endsWith(TRUNCATION_MARKER));
        assert.equal(event?.eventType?.length, LIMITS.max_error_message_chars + TRUNCATION_MARKER.length);
    });

    it('carries the trace id, message and event_type to the retry warning and the final event', async () => {
        const premature = 'data: {"type":"PrematureEnd","reason":"Unknown","message":"upstream closed","event_type":"premature_end"}\n';
        const http = makeClient({ attempts: [[premature]], headers: { 'grazie-trace-id': 'trace-abc' } });
        const events = await drain({ session: makeSession({ http }), http });
        const retry = http.warnings.find((w) => w.code === 'STREAM_PREMATURE_RETRY');
        assert.equal(retry?.traceId, 'trace-abc', 'the retry warning can be correlated with JetBrains support');
        assert.equal(retry?.detail, 'upstream closed');
        const last = events.at(-1);
        assert.equal(last.type, 'premature_end');
        assert.equal(last.traceId, 'trace-abc');
        assert.equal(last.message, 'upstream closed');
        assert.equal(last.eventType, 'premature_end');
    });
});

describe('JAI stream end without FinishMetadata', () => {
    it('treats content followed by a clean EOF as a truncation', async () => {
        const http = makeClient({ attempts: [[content({ t: 'partial' })]] });
        const events = await drain({ session: makeSession({ http }), http });
        const last = events.at(-1);
        assert.equal(last.type, 'premature_end');
        assert.equal(last.reason, 'missing_finish');
    });

    it('leaves an empty clean EOF alone', async () => {
        const http = makeClient({ attempts: [[]] });
        const events = await drain({ session: makeSession({ http }), http });
        assert.equal(http.count(), 1);
        assert.equal(events.length, 0);
    });

    it('does not invent a truncation when FinishMetadata arrived', async () => {
        const http = makeClient({ attempts: [[content({ t: 'ok' }), finish]] });
        const events = await drain({ session: makeSession({ http }), http });
        assert.deepEqual(events.map((e) => e.type), ['text', 'finish']);
        assert.equal(events.some((e) => e.type === 'premature_end'), false);
    });
});

describe('JAI request headers match the shipped gateway contract', () => {
    it('sends Grazie-Provide-Debug-Info and the *-JWT impersonation names, redacted in telemetry', async () => {
        const real = globalThis.fetch;
        const emitter = new EventEmitter();
        /** @type {any} */
        let seen = null;
        emitter.on(EVENTS.CLIENT.API_REQUEST, (/** @type {any} */ meta) => { seen = meta; });
        try {
            globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, status: 200, headers: {}, body: {} }));
            const client = new InternalHttpClient({ options: {
                token: 'jwt-secret',
                userToken: 'user-jwt',
                originalServiceToken: 'svc-jwt',
                originalApplicationToken: 'app-jwt',
                applicationUserId: 'user-id-1',
                provideDebugInfo: true,
            }, eventEmitter: emitter });
            await client._fetchWithRetry({ path: '/llm/chat/stream/v9', options: { method: 'POST', body: '{}' } });
            assert.ok(seen, 'api_request emitted');
            assert.equal(seen.headers['Grazie-Provide-Debug-Info'], 'true');
            assert.equal(seen.headers['Grazie-Original-User-JWT'], '[REDACTED]');
            assert.equal(seen.headers['Grazie-Original-Service-JWT'], '[REDACTED]');
            assert.equal(seen.headers['Grazie-Original-Application-JWT'], '[REDACTED]');
            assert.equal(seen.headers['Grazie-Application-User-ID'], 'user-id-1');

            // The pre-fix spellings must stay redacted if a caller or a proxy
            // still sends them.
            await client._fetchWithRetry({ path: '/llm/chat/stream/v9', options: {
                method: 'POST',
                body: '{}',
                headers: { 'Grazie-Original-User-Token': 'legacy-user', 'grazie-original-service-token': 'legacy-svc' },
            } });
            assert.equal(seen.headers['Grazie-Original-User-Token'], '[REDACTED]');
            assert.equal(seen.headers['grazie-original-service-token'], '[REDACTED]');
        } finally { globalThis.fetch = real; }
    });
});

describe('JAI transport without an emitter', () => {
    it('retries a premature end and reports the truncation without throwing', async () => {
        const premature = 'data: {"type":"PrematureEnd","reason":"Unknown"}\n';
        const http = makeClient({ attempts: [[content({ t: 'partial' }), premature]] });
        delete (/** @type {any} */ (http).getEventEmitter);
        delete (/** @type {any} */ (http).emitter);
        const session = new ChatSession({ httpClient: /** @type {any} */ (http), profile: 'jai-gemini', profileManager: null });
        /** @type {any[]} */
        const events = [];
        for await (const e of session.stream({ initialInput: [{ type: 'user_message', content: 'go' }] })) events.push(e);
        assert.equal(events.at(-1).type, 'premature_end');
        assert.equal(events.at(-1).reason, 'Unknown');
    });

    it('treats an emitter-less clean EOF with content as a truncation', async () => {
        const http = makeClient({ attempts: [[content({ t: 'partial' })]] });
        delete (/** @type {any} */ (http).getEventEmitter);
        delete (/** @type {any} */ (http).emitter);
        const session = new ChatSession({ httpClient: /** @type {any} */ (http), profile: 'jai-gemini', profileManager: null });
        /** @type {any[]} */
        const events = [];
        for await (const e of session.stream({ initialInput: [{ type: 'user_message', content: 'go' }] })) events.push(e);
        assert.equal(events.at(-1).type, 'premature_end');
        assert.equal(events.at(-1).reason, 'missing_finish');
    });
});

describe('JAI profile limits are part of the public roster', () => {
    it('getProfiles returns contextLimit and maxOutputTokens', async () => {
        const client = new MerciClient({ options: { token: 't', endpoint: 'https://example.invalid' } });
        client.profiles.getProfiles = async () => ({
            p1: { id: 'p1', name: 'P1', contextLimit: 1048576, maxOutputTokens: 65536 },
            p2: { id: 'p2' },
        });
        const profiles = await client.getProfiles();
        assert.deepEqual(profiles.find((p) => p.id === 'p1'), { id: 'p1', name: 'P1', contextLimit: 1048576, maxOutputTokens: 65536 });
        assert.deepEqual(profiles.find((p) => p.id === 'p2'), { id: 'p2', name: 'p2', contextLimit: null, maxOutputTokens: null });
    });
});
