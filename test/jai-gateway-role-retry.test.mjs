// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { InternalHttpClient } from '../lib/backends/jai-vendor/http-client.mjs';
import { ChatSession as JaiChatSession } from '../lib/backends/jai-vendor/chat-session.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

const ROLE_ERR = 'with code 400: {"error":{"code":400,"message":"Please use a valid role: user, model.","status":"INVALID_ARGUMENT"}}';
const MODEL_TURN_ERR = 'Exception during request to https://aiplatform.googleapis.com/... with code 400: {"error":{"code":400,"message":"Requests ending with a model turn are not supported.","status":"INVALID_ARGUMENT"}}';
const TOOL_BODY = '{"profile":"p","chat":{"messages":[{"type":"user_message","content":"x"},{"type":"assistant_message_tool","content":"{}"},{"type":"tool_message","result":"ok"}]}}';

/**
 * @param {{replies: string[], errorText?: string}} arg0
 */
function stubFetch({ replies, errorText = ROLE_ERR }) {
    /** @type {any[]} */
    const calls = [];
    globalThis.fetch = async (/** @type {any} */ url, /** @type {any} */ opts) => {
        calls.push(opts.body);
        const r = replies.shift();
        return r === 'ok'
            ? /** @type {any} */ ({ ok: true, status: 200, headers: {}, body: {} })
            : /** @type {any} */ ({ ok: false, status: 400, headers: {}, text: async () => errorText });
    };
    return calls;
}

test('retries the gateway role error until it lands', async () => {
    const real = globalThis.fetch;
    const calls = stubFetch({ replies: ['fail', 'fail', 'fail', 'ok'] });
    try {
        const c = new InternalHttpClient({ options: { token: 't' }, eventEmitter: new EventEmitter() });
        const res = await c._fetchWithRetry({ path: '/llm/chat/stream/v9', options: { method: 'POST', body: '{}' } });
        assert.equal(res.ok, true);
        assert.equal(calls.length, 4, 'should resubmit the same body until success');
    } finally { globalThis.fetch = real; }
});

test('gives up after the retry budget instead of looping forever', async () => {
    const real = globalThis.fetch;
    const calls = stubFetch({ replies: Array(20).fill('fail') });
    try {
        const c = new InternalHttpClient({ options: { token: 't' }, eventEmitter: new EventEmitter() });
        await assert.rejects(
            c._fetchWithRetry({ path: '/llm/chat/stream/v9', options: { method: 'POST', body: '{}' } }),
            /status 400/
        );
        assert.equal(calls.length, 7, '1 initial attempt + 6 retries');
    } finally { globalThis.fetch = real; }
});

test('non-JSON 400 on a tool-message turn is retried until it lands', async () => {
    const real = globalThis.fetch;
    const calls = stubFetch({ replies: ['fail', 'fail', 'ok'], errorText: 'upstream exploded' });
    try {
        const c = new InternalHttpClient({ options: { token: 't' }, eventEmitter: new EventEmitter() });
        const res = await c._fetchWithRetry({ path: '/llm/chat/stream/v9', options: { method: 'POST', body: TOOL_BODY } });
        assert.equal(res.ok, true);
        assert.equal(calls.length, 3, 'identical body resubmitted');
        assert.ok(calls.every((b) => b === TOOL_BODY), 'body must be byte-identical across retries');
    } finally { globalThis.fetch = real; }
});

test('non-JSON 400 on a tool-message turn gives up after the budget', async () => {
    const real = globalThis.fetch;
    const calls = stubFetch({ replies: Array(20).fill('fail'), errorText: 'upstream exploded' });
    try {
        const c = new InternalHttpClient({ options: { token: 't' }, eventEmitter: new EventEmitter() });
        await assert.rejects(
            c._fetchWithRetry({ path: '/llm/chat/stream/v9', options: { method: 'POST', body: TOOL_BODY } }),
            /status 400/
        );
        assert.equal(calls.length, 7, '1 initial attempt + 6 retries');
    } finally { globalThis.fetch = real; }
});

test('non-JSON 400 without tool-message history stays fatal (no retry storm)', async () => {
    const real = globalThis.fetch;
    const calls = stubFetch({ replies: Array(20).fill('fail'), errorText: 'upstream exploded' });
    try {
        const c = new InternalHttpClient({ options: { token: 't' }, eventEmitter: new EventEmitter() });
        await assert.rejects(
            c._fetchWithRetry({ path: '/task/roster', options: { method: 'GET', body: '{"parameters":{}}' } }),
            /status 400/
        );
        assert.equal(calls.length, 1, 'non-tool requests must not be retried on 400');
    } finally { globalThis.fetch = real; }
});

test('unparseable 400 errors expose the raw body snippet', async () => {
    const real = globalThis.fetch;
    const calls = stubFetch({ replies: Array(20).fill('fail'), errorText: 'upstream exploded' });
    try {
        const c = new InternalHttpClient({ options: { token: 't' }, eventEmitter: new EventEmitter() });
        await assert.rejects(
            c._fetchWithRetry({ path: '/llm/chat/stream/v9', options: { method: 'POST', body: TOOL_BODY } }),
            /upstream exploded/
        );
    } finally { globalThis.fetch = real; }
});

test('the model-turn rejection is NOT retried (deterministic shape error)', async () => {
    const real = globalThis.fetch;
    const calls = stubFetch({ replies: Array(20).fill('fail'), errorText: MODEL_TURN_ERR });
    try {
        const c = new InternalHttpClient({ options: { token: 't' }, eventEmitter: new EventEmitter() });
        await assert.rejects(
            c._fetchWithRetry({ path: '/llm/chat/stream/v9', options: { method: 'POST', body: TOOL_BODY } }),
            /Requests ending with a model turn/
        );
        assert.equal(calls.length, 1, 'must fail fast, not resubmit');
    } finally { globalThis.fetch = real; }
});

test('the thought_signature rejection is NOT retried (deterministic shape error)', async () => {
    const real = globalThis.fetch;
    const THOUGHT_SIG_ERR = 'Exception during request to https://aiplatform.googleapis.com/... with code 400: {"error":{"code":400,"message":"Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call `default_api:extract_single_action_item` , position 4.","status":"INVALID_ARGUMENT"}}';
    const calls = stubFetch({ replies: Array(20).fill('fail'), errorText: THOUGHT_SIG_ERR });
    try {
        const c = new InternalHttpClient({ options: { token: 't' }, eventEmitter: new EventEmitter() });
        await assert.rejects(
            c._fetchWithRetry({ path: '/llm/chat/stream/v9', options: { method: 'POST', body: TOOL_BODY } }),
            /thought_signature/
        );
        assert.equal(calls.length, 1, 'must fail fast, not resubmit');
    } finally { globalThis.fetch = real; }
});

test('empty model turns never enter the history (poisoned-tail guard)', async () => {
    const session = new JaiChatSession({ httpClient: new InternalHttpClient({ options: { token: 't' }, eventEmitter: new EventEmitter() }), profile: 'p', profileManager: null });
    const history = [{ type: 'user_message', content: 'hi' }];
    const opts = /** @type {any} */ ({ provider: ProviderType.JAI, history, toolCalls: [], results: null, thoughtSignature: null, formatToolCall: () => ({}) });

    const empty = session._formatFinalMessages({ ...opts, text: '   ' });
    assert.equal(empty.length, 1, 'whitespace-only text must not append an assistant message');
    assert.equal(empty[0].type, 'user_message');

    const filled = session._formatFinalMessages({ ...opts, text: ' answer ' });
    assert.equal(filled.length, 2, 'non-empty text still appends the assistant turn');
    assert.equal(filled[1].type, 'assistant_message_text');
    assert.equal(filled[1].content, 'answer', 'turn content is trimmed');
});

// ponytail: api_request is an observable telemetry surface (example 07 forwards
test('api_request events redact the JWT and original-user tokens', async () => {
    const real = globalThis.fetch;
    const emitter = new EventEmitter();
    /** @type {any} */
    let seen = null;
    emitter.on('api_request', (meta) => { seen = meta; });
    try {
        globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, status: 200, headers: {}, body: {} }));
        const c = new InternalHttpClient({ options: {
            token: 'jwt-secret-abc',
            userToken: 'user-tok',
            originalServiceToken: 'svc-tok'
        }, eventEmitter: emitter });
        await c._fetchWithRetry({ path: '/llm/chat/stream/v9', options: { method: 'POST', body: '{}' } });
        assert.ok(seen, 'api_request emitted');
        assert.equal(seen.headers['Grazie-Authenticate-JWT'], '[REDACTED]');
        assert.equal(seen.headers['Grazie-Original-User-Token'], '[REDACTED]');
        assert.equal(seen.headers['Grazie-Original-Service-Token'], '[REDACTED]');
        assert.ok(!seen.headers['Grazie-Authenticate-JWT'].includes('jwt-secret-abc'));
        assert.ok(!seen.headers['Grazie-Original-User-Token'].includes('user-tok'));
        assert.ok(!seen.headers['Grazie-Original-Service-Token'].includes('svc-tok'));
    } finally { globalThis.fetch = real; }
});

test('api_request redaction is case-insensitive (odd-cased caller headers cannot leak)', async () => {
    const real = globalThis.fetch;
    const emitter = new EventEmitter();
    /** @type {any} */
    let seen = null;
    emitter.on('api_request', (meta) => { seen = meta; });
    try {
        globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, status: 200, headers: {}, body: {} }));
        const c = new InternalHttpClient({ options: { token: 'jwt-secret-abc' }, eventEmitter: emitter });
        await c._fetchWithRetry({ path: '/llm/chat/stream/v9', options: {
            method: 'POST',
            body: '{}',
            headers: { 'grazie-authenticate-jwt': 'odd-cased-token' }
        } });
        assert.equal(seen.headers['grazie-authenticate-jwt'], '[REDACTED]', 'lowercase casing must be redacted too');
    } finally { globalThis.fetch = real; }
});
