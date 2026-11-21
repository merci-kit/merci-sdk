// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runAgenticLoop, fallbackKind, isSdkFallbackOutput, isTransientFallbackKind, streamErrorToRetryError } from '../lib/agentic/agentic-core.mjs';
import { ExponentialBackoffPolicy } from '../lib/support/retry-policy.mjs';
import { structuredLlmCall } from '../lib/agentic/planning/planner-utils.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';
import { isInjection } from '../lib/messaging/unified-message.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { FALLBACK_MESSAGE } from '../lib/core/constants/index.mjs';

const SCHEMA = {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name']
};

/**
 * Fake session whose step returns scripted content per call.
 * @param {{script: (call: number, messages: any[]) => string, extra?: Record<string, any>}} arg0
 */
function makeSession({ script, extra = {} }) {
    /** @type {any[]} */
    const seenMessages = [];
    const session = {
        provider: 'OAI',
        model: 'test-model',
        _tools: [],
        eventEmitter: { emit: () => {} },
        ...extra,
        /** @param {{messages: *}} arg0 */
        async *step({ messages }) {
            seenMessages.push(messages);
            return { done: true, content: script(seenMessages.length, messages), messages };
        },
    };
    return { session, seenMessages };
}

// ─── C17: corrective retry for a schema-invalid deliverable ─────────────────

test('C17: a schema-invalid deliverable is corrected in-session, not sentineled', async () => {
    let calls = 0;
    const { session } = makeSession({ script: () => (++calls === 1 ? 'not json at all' : '{"name":"repaired"}'), extra: {
        _outputSchema: SCHEMA,
    } });
    const events = /** @type {any[]} */ ([]);
    const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'give me json' })], opts: {
        maxIterations: 5,
        onEvent: /** @type {(e: any) => void} */ ((e) => events.push(e)),
    } });
    assert.equal(out, '{"name":"repaired"}', 'the corrected deliverable must be returned, not the sentinel');
    assert.equal(calls, 2, 'one corrective retry');
    assert.equal(events.filter((e) => e.type === 'schema_validation_failed').length, 1);
});

test('C17: the correction turn names the schema failure and is a synthetic injection', async () => {
    let calls = 0;
    const { session, seenMessages } = makeSession({ script: () => (++calls === 1 ? '{"nope":1}' : '{"name":"ok"}'), extra: { _outputSchema: SCHEMA } });
    const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'give me json' })], opts: { maxIterations: 5 } });
    assert.equal(out, '{"name":"ok"}');
    const secondTurn = seenMessages[1];
    const correction = secondTurn[secondTurn.length - 1];
    assert.equal(correction.role, 'user');
    assert.ok(isInjection({ m: correction }), 'the correction turn must be marked synthetic');
    assert.match(String(correction.content), /must have required property 'name'/);
    assert.match(String(correction.content), /Output ONLY the JSON object/);
});

test('C17: exhausted corrective retries return a schema-classified sentinel, distinct from empty', async () => {
    let calls = 0;
    const emitter = new EventEmitter();
    const ends = /** @type {any[]} */ ([]);
    emitter.on(EVENTS.CLIENT.RUN_END, (e) => ends.push(e));
    const { session } = makeSession({ script: () => (++calls, 'still not json'), extra: { _outputSchema: SCHEMA, eventEmitter: emitter } });
    const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'give me json' })], opts: { maxIterations: 5 } });
    assert.equal(calls, 3, '1 initial + DEFAULT_MAX_SCHEMA_RETRIES (2)');
    assert.equal(fallbackKind({ text: out }), 'schema', 'a schema miss must be distinguishable from an empty answer');
    assert.equal(isSdkFallbackOutput({ text: out }), true, 'still a non-answer for every engine guard');
    assert.equal(isTransientFallbackKind({ kind: 'schema' }), true, 'schema is retryable like empty');
    assert.equal(ends[0]?.event, EVENTS.CLIENT.RUN_END);
    assert.equal(ends[0]?.finishReason, 'schema', 'run:end reports the schema exhaustion');
});

test('C17: no output schema → no corrective retry (unchanged)', async () => {
    let calls = 0;
    const { session } = makeSession({ script: () => (++calls, 'plain answer') });
    const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: { maxIterations: 5 } });
    assert.equal(out, 'plain answer');
    assert.equal(calls, 1);
});

test('C17: maxSchemaRetries: 0 disables the internal retry', async () => {
    let calls = 0;
    const { session } = makeSession({ script: () => (++calls, 'not json'), extra: { _outputSchema: SCHEMA } });
    const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'give me json' })], opts: {
        maxIterations: 5,
        maxSchemaRetries: 0,
    } });
    assert.equal(calls, 1);
    assert.equal(fallbackKind({ text: out }), 'schema');
});

test('C17: structuredLlmCall disables the internal retry (no attempt multiplication)', async () => {
    /** @type {any} */
    let runOptions = null;
    const session = {
        provider: 'openai',
        withSystemMessage() { return session; },
        withTools() { return session; },
        withParameters() { return session; },
        /** @param {{options: *}} arg0 */
        async run({ options }) { runOptions = options; return '{"name":"ok"}'; },
    };
    const client = { session: () => session };
    const data = await structuredLlmCall(/** @type {any} */ ({
        client, model: 'm', systemMessage: 's', schema: SCHEMA, prompt: 'do it',
    }));
    assert.deepEqual(data, { name: 'ok' });
    assert.equal(runOptions?.maxSchemaRetries, 0);
});

// ─── B-5: fallback sentinels are not answers ────────────────────────────────

test('B-5: a content-filtered sentinel is not real output and an empty run is not finishReason stop', async () => {
    assert.equal(fallbackKind({ text: FALLBACK_MESSAGE.CONTENT_FILTERED }), 'filtered', 'the moderation notice is a sentinel every engine guard can recognise');
    assert.equal(isTransientFallbackKind({ kind: 'filtered' }), false, 'a moderation stop is not retryable');
    assert.equal(isSdkFallbackOutput({ text: FALLBACK_MESSAGE.CONTENT_FILTERED }), true);

    const emitter = new EventEmitter();
    const ends = /** @type {any[]} */ ([]);
    emitter.on(EVENTS.CLIENT.RUN_END, (e) => ends.push(e));
    const { session } = makeSession({ script: () => '', extra: { eventEmitter: emitter } });
    const out = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'go' })], opts: {
        maxIterations: 3,
        maxConsecutiveEmpty: 2,
    } });
    assert.equal(out, FALLBACK_MESSAGE.EMPTY_RESPONSE);
    assert.equal(fallbackKind({ text: out }), 'empty');
    assert.equal(ends[0]?.finishReason, 'empty', 'an empty run must not report finishReason stop');

    // W2B-2: the JAI synthesis branch returns the same sentinel earlier in the
    // loop (after a tool round, when a recovery is impossible). It must set
    // `exhausted` too, or run:end still calls the sentinel 'stop'.
    const jaiEmitter = new EventEmitter();
    const jaiEnds = /** @type {any[]} */ ([]);
    jaiEmitter.on(EVENTS.CLIENT.RUN_END, (e) => jaiEnds.push(e));
    let jaiCalls = 0;
    const jaiSession = {
        provider: 'jai',
        model: 'm',
        _tools: [],
        eventEmitter: jaiEmitter,
        /** @param {{messages: any[]}} arg0 */
        async *step({ messages }) {
            jaiCalls += 1;
            if (jaiCalls === 1) {
                return { done: false, messages: [...messages, { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'noop', arguments: '{}' } }] }] };
            }
            return { done: true, content: '', messages };
        },
    };
    const jaiOut = await runAgenticLoop({ session: jaiSession, messages: [createUserMessage({ provider: 'jai', content: 'go' })], opts: { maxIterations: 2 } });
    assert.equal(jaiOut, FALLBACK_MESSAGE.EMPTY_RESPONSE, 'the JAI synthesis branch returns the empty sentinel');
    assert.equal(jaiEnds[0]?.finishReason, 'empty', 'the JAI synthesis sentinel is not finishReason stop');
});

test('B-5: a mid-stream vendor error is thrown, so the run-level retry policy can act', async () => {
    const session = {
        provider: 'OAI',
        model: 'm',
        _tools: [],
        async *step() {
            return { done: true, content: 'partial', messages: [], streamError: { type: 'error', error_message: 'Overloaded', error_type: 'server_error' } };
        },
    };
    await assert.rejects(
        runAgenticLoop({ session: /** @type {any} */ (session), messages: [createUserMessage({ provider: 'OAI', content: 'go' })], opts: { maxIterations: 3 } }),
        (err) => /Overloaded/.test(String(/** @type {any} */ (err).message)) && (/** @type {any} */ (err).status === 500),
        'a stream error is a retryable failure, not a resolved answer'
    );
});

test('W2B-4: a 4xx stream error frame is permanent, a 5xx frame is transient', () => {
    const policy = new ExponentialBackoffPolicy({ maxRetries: 3, initialDelayMs: 1, maxDelayMs: 2, jitterMs: 0 });

    const permanent = streamErrorToRetryError({ error: { type: 'error', status: 400, error_type: 'context_length_exceeded', error_message: 'the prompt is too long' } });
    assert.equal(permanent.status, 400, 'the vendor status is carried, not replaced by 500');
    assert.equal(permanent.type, 'context_length_exceeded', 'the vendor type is carried');
    assert.equal(policy.shouldRetry({ error: permanent, attempt: 0 }).retry, false, 'a 400 frame is a request the vendor refuses again');

    const transient = streamErrorToRetryError({ error: { type: 'error', status: 500, error_type: 'server_error', error_message: 'overloaded' } });
    assert.equal(transient.status, 500);
    assert.equal(policy.shouldRetry({ error: transient, attempt: 0 }).retry, true, 'a 500 frame is transient');
});
