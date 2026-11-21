// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ExponentialBackoffPolicy, NoRetryPolicy } from '../lib/support/retry-policy.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

const USER_MSG = [{ type: 'user_message', role: 'user', content: 'ping' }];

const rateLimit429 = () =>
    Object.assign(new Error('got status: RESOURCE_EXHAUSTED. { "code": 429, "message": "Quota exceeded" }'), { status: 429 });

const okStream = () => (async function* () {
    yield { text: 'Hello, ' };
    yield { text: 'world.' };
})();


/**
 * @param {() => Error} error
 */
/** @param {{error: *}} arg0 */
/** @param {{error: *}} arg0 */
const rejectedAtOpen = ({ error }) => (async function* () {
    throw error();
})();


/**
 * @param {string} partial
 * @param {() => Error} error
 */
/** @param {{partial: *, error: *}} arg0 */
/** @param {{partial: *, error: *}} arg0 */
const dyingAfterPartial = ({ partial, error }) => (async function* () {
    yield { text: partial };
    throw error();
})();


/**
 * @param {{ type?: string, error_message?: string, error_type?: string }} event
 */
/** @param {{event: *}} arg0 */
/** @param {{event: *}} arg0 */
const errorEventAtOpen = ({ event }) => (async function* () {
    yield { type: 'error', ...event };
})();


/**
 * @param {{streams: *}} arg0
 */
function makeAdapter({ streams }) {
    let calls = 0;
    return {
        vendorName: 'STUB',
        calls: () => calls,
        
        /**
         * @param {{ model?: any }} param0
         */
                buildVendorRequest({ model }) {
            return { request: { model }, observability: { model } };
        },
        executeVendorRequest() {
            const i = Math.min(calls, streams.length - 1);
            calls++;
            return streams[i]();
        },
        /** @param {{rawStream: *}} arg0 */
        consumeStream({ rawStream }) {
            return (async function* () {
                for await (const chunk of rawStream) {
                    if (chunk && typeof chunk.text === 'string') {
                        yield { type: 'text', content: chunk.text };
                    } else if (chunk && chunk.type === 'error') {
                        yield { type: 'error', error_message: chunk.error_message, error_type: chunk.error_type };
                    }
                }
            })();
        },
        extractXmlToolCalls() { return []; },
        /** @param {{call: *}} arg0 */
        formatToolCall({ call }) { return { id: call.id, name: call.name, args: call.args }; },
    };
}

class StubSession extends AbstractChatSession {
    /** @param {{adapter: *, vendorClient?: *, emitter?: *}} arg0 */
    constructor({ adapter, vendorClient = {}, emitter = new EventEmitter() }) {
        super({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: emitter, client: null, vendorClient });
        this._adapter = adapter;
    }
}


/**
  * @param {{gen: *, events?: *}} arg0
 */
async function collect({ gen, events = [] }) {
    let r = await gen.next();
    while (!r.done) {
        events.push(r.value);
        r = await gen.next();
    }
    return r.value;
}

test('step(): pre-delivery HTTP 429 retries once and matches a straight success exactly', async () => {
    const adapter = makeAdapter({ streams: [() => rejectedAtOpen({ error: rateLimit429 }), okStream] });
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const retries =  ([]);
    emitter.on('api_retry', (m) => retries.push(m));
    const session =  (new StubSession({ adapter, vendorClient: { fake: 'vendor' }, emitter }).withRetryPolicy({ policy: new ExponentialBackoffPolicy({ maxRetries: 1, initialDelayMs: 10, maxDelayMs: 50, jitterMs: 0 }) }));

    /** @type {any[]} */
    const events =  ([]);
    const finalState = await collect({ gen: /** @type {any} */ (session).step({ messages: USER_MSG }), events });

    assert.equal(adapter.calls(), 2, 'the vendor request must be attempted exactly twice');

    assert.deepEqual(events.map((e) => e.content), ['Hello, ', 'world.'],
        "the consumer must see exactly the successful attempt's events");

    assert.equal(finalState.done, true);
    assert.equal(finalState.content, 'Hello, world.');
    assert.equal(finalState.streamError, undefined, 'a retried 429 must not leak into the final state');

    assert.equal(retries.length, 1, 'one retry must be reported');
    assert.equal(retries[0].attempt, 0);
    assert.equal(retries[0].nextDelayMs, 10);
    assert.equal(retries[0].error.status, 429);

    // ponytail: createAssistantMessage stamps a random `merciId` per message —
    /** @param {{m: *}} arg0 */
    /** @param {{m: *}} arg0 */
    const stripIds = ({ m }) => m.messages?.map(/** @type {(...args: any[]) => any} */ (( row) => ({ ...row, merciId: undefined }))) ?? m.messages;
    const clean = makeAdapter({ streams: [okStream] });
    /** @type {any[]} */
    const cleanEvents =  ([]);
    const cleanFinal = await collect({ gen: new StubSession({ adapter: clean }).step({ messages: USER_MSG }), events: cleanEvents });
    assert.deepEqual(events, cleanEvents,
        'retried step must yield the identical event sequence as a straight success');
    assert.deepEqual(
        { ...finalState, messages: stripIds({ m: finalState }) },
        { ...cleanFinal, messages: stripIds({ m: cleanFinal }) },
        'retried step must end in the identical final state as a straight success');
});

test('step(): a mid-stream failure after the first delta is never retried and the delta stays delivered', async () => {
    const adapter = makeAdapter({ streams: [() => dyingAfterPartial({ partial: 'LEAKED-PARTIAL', error: () => Object.assign(new Error('connection reset'), { status: 500 }) })] });
    const session =  (new StubSession({ adapter }).withRetryPolicy({ policy: new ExponentialBackoffPolicy({ maxRetries: 5, initialDelayMs: 1, maxDelayMs: 10, jitterMs: 0 }) }));

    /** @type {any[]} */
    const events =  ([]);
    await assert.rejects(
        () => collect({ gen: /** @type {any} */ (session).step({ messages: USER_MSG }), events }),
        /connection reset/,
        'a mid-stream failure must propagate to the caller'
    );

    assert.equal(adapter.calls(), 1, 'no retry once a delta was delivered');
    assert.deepEqual(events.map((e) => e.content), ['LEAKED-PARTIAL'],
        "the already-delivered delta must not be swallowed");
});

test('step(): a pre-delivery failure retries under the DEFAULT session policy, then surfaces untouched', async () => {
    const adapter = makeAdapter({ streams: [() => rejectedAtOpen({ error: rateLimit429 })] });
    const session = new StubSession({ adapter });
    /** @type {any[]} */
    const events =  ([]);
    await assert.rejects(
        () => collect({ gen: session.step({ messages: USER_MSG }), events }),
        ( e) => /** @type {any} */ (e).status === 429,
        'after the default retry budget the original vendor error reaches the caller'
    );
    assert.equal(adapter.calls(), 3, 'default policy retries twice (1 + 2 attempts)');
    assert.equal(events.length, 0, 'no events from a failed pre-delivery attempt');
});

test('step(): an abort during the retry backoff after a pre-delivery failure is NOT retried', async () => {
    const adapter = makeAdapter({ streams: [() => rejectedAtOpen({ error: () => Object.assign(new Error('boom'), { status: 500 }) })] });
    const policy = new ExponentialBackoffPolicy({ maxRetries: 5, initialDelayMs: 5000, maxDelayMs: 5000 });
    const emitter = new EventEmitter();
    const session =  (new StubSession({ adapter, vendorClient: { fake: 'vendor' }, emitter }).withRetryPolicy({ policy }));
    const controller = new AbortController();
    emitter.on('api_retry', () => queueMicrotask(() => controller.abort(new Error('user cancel'))));
    const start = Date.now();
    await assert.rejects(
        () => collect({ gen: /** @type {any} */ (session).step({ messages: USER_MSG, options: { signal: controller.signal } }) }),
        ( e) => /** @type {any} */ (e).name === 'AbortError' || /** @type {any} */ (e).name === 'AbortedError'
    );
    assert.ok(Date.now() - start < 2000, 'abort must interrupt the backoff sleep');
    assert.equal(adapter.calls(), 1, 'no retry after an abort');
});

// ─── First-event provider errors (MALFORMED_FUNCTION_CALL class) ─────────────

const malformed = () => ({
    type: 'error',
    error_message: 'Candidates were blocked because of malformed and unparsable function call. MALFORMED_FUNCTION_CALL',
    error_type: 'MALFORMED_FUNCTION_CALL'
});

test('step(): a first-event stream error retries under the policy and delivers only the success', async () => {
    const adapter = makeAdapter({ streams: [() => errorEventAtOpen({ event: malformed() }), okStream] });
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const retries =  ([]);
    emitter.on('api_retry', (m) => retries.push(m));
    const session =  (new StubSession({ adapter, vendorClient: { fake: 'vendor' }, emitter }).withRetryPolicy({ policy: new ExponentialBackoffPolicy({ maxRetries: 1, initialDelayMs: 10, maxDelayMs: 50, jitterMs: 0 }) }));

    /** @type {any[]} */
    const events =  ([]);
    const finalState = await collect({ gen: /** @type {any} */ (session).step({ messages: USER_MSG }), events });

    assert.equal(adapter.calls(), 2, 'the vendor request must be attempted exactly twice');
    assert.deepEqual(events.map((e) => e.content), ['Hello, ', 'world.'],
        'the failed attempt must not leak an error event or partial text');
    assert.equal(finalState.streamError, undefined, 'a retried first-event error must not leak into the final state');
    assert.equal(retries.length, 1, 'one retry must be reported');
    assert.equal(retries[0].error.status, 500, 'the synthesized provider error is classified transient');
});

test('step(): a first-event SAFETY error is never retried and stays a yielded streamError', async () => {
    const adapter = makeAdapter({ streams: [() => errorEventAtOpen({ event: { type: 'error', error_message: 'blocked for safety', error_type: 'SAFETY' } })] });
    const session =  (new StubSession({ adapter }).withRetryPolicy({ policy: new ExponentialBackoffPolicy({ maxRetries: 3, initialDelayMs: 1, maxDelayMs: 5, jitterMs: 0 }) }));

    /** @type {any[]} */
    const events =  ([]);
    const finalState = await collect({ gen: /** @type {any} */ (session).step({ messages: USER_MSG }), events });

    assert.equal(adapter.calls(), 1, 'a deterministic safety block must not be retried');
    assert.ok(events.some((e) => e.type === 'error' && e.error_type === 'SAFETY'),
        'the error event must still reach the consumer');
    assert.equal(finalState.streamError?.error_type, 'SAFETY');
});

test('step(): with an explicit NoRetryPolicy a first-event error is yielded, never thrown', async () => {
    const adapter = makeAdapter({ streams: [() => errorEventAtOpen({ event: malformed() })] });
    const session =  (new StubSession({ adapter }).withRetryPolicy({ policy: new NoRetryPolicy() }));

    /** @type {any[]} */
    const events =  ([]);
    const finalState = await collect({ gen: /** @type {any} */ (session).step({ messages: USER_MSG }), events });

    assert.equal(adapter.calls(), 1, 'NoRetryPolicy must not retry');
    assert.ok(events.some((e) => e.type === 'error' && e.error_type === 'MALFORMED_FUNCTION_CALL'),
        'the error event must be yielded, preserving the streamError contract');
    assert.equal(finalState.streamError?.error_type, 'MALFORMED_FUNCTION_CALL');
    assert.equal(finalState.done, true);
});

// ─── Vendor error codes on the first event (S-14) ────────────────────────────

test('step(): a first-event server_error retries and delivers only the success', async () => {
    const adapter = makeAdapter({ streams: [
        () => errorEventAtOpen({ event: { type: 'error', error_message: 'The engine is currently overloaded', error_type: 'server_error' } }),
        okStream,
    ] });
    const session =  (new StubSession({ adapter }).withRetryPolicy({ policy: new ExponentialBackoffPolicy({ maxRetries: 1, initialDelayMs: 10, maxDelayMs: 50, jitterMs: 0 }) }));

    /** @type {any[]} */
    const events =  ([]);
    const finalState = await collect({ gen: /** @type {any} */ (session).step({ messages: USER_MSG }), events });

    assert.equal(adapter.calls(), 2, 'a transient vendor code is retried once');
    assert.deepEqual(events.map((e) => e.content), ['Hello, ', 'world.']);
    assert.equal(finalState.streamError, undefined);
});

test('step(): a first-event invalid_prompt is never retried and stays a yielded streamError', async () => {
    const adapter = makeAdapter({ streams: [
        () => errorEventAtOpen({ event: { type: 'error', error_message: 'invalid prompt: the input was rejected', error_type: 'invalid_prompt' } }),
    ] });
    const session =  (new StubSession({ adapter }).withRetryPolicy({ policy: new ExponentialBackoffPolicy({ maxRetries: 3, initialDelayMs: 1, maxDelayMs: 5, jitterMs: 0 }) }));

    /** @type {any[]} */
    const events =  ([]);
    const finalState = await collect({ gen: /** @type {any} */ (session).step({ messages: USER_MSG }), events });

    assert.equal(adapter.calls(), 1, 'a fatal vendor code must not be retried even though the error carries status 500');
    assert.ok(events.some((e) => e.type === 'error' && e.error_type === 'invalid_prompt'), 'the error event still reaches the consumer');
    assert.equal(finalState.streamError?.error_type, 'invalid_prompt');
});

test('step(): the synthesized first-event error carries the vendor verdict as .code and keeps status 500', async () => {
    /** @type {any[]} */
    const seen = [];
    const policy = {
        /** @param {{error: any}} arg0 */
        shouldRetry: ({ error }) => { seen.push(error); return { retry: false, delayMs: 0 }; },
    };
    const run = async (/** @type {string} */ errorType) => {
        const adapter = makeAdapter({ streams: [() => errorEventAtOpen({ event: { type: 'error', error_message: 'blocked', error_type: errorType } })] });
        const session =  (new StubSession({ adapter }).withRetryPolicy({ policy }));
        await collect({ gen: /** @type {any} */ (session).step({ messages: USER_MSG }) });
    };

    await run('MALFORMED_FUNCTION_CALL');
    assert.equal(seen.length, 1, 'the policy is consulted once');
    assert.equal(seen[0].code, 'MALFORMED_FUNCTION_CALL', "the event's error_type is copied onto .code");
    assert.equal(seen[0].status, 500, 'a non-matching error_type still classifies as transient by status');

    await run('SAFETY');
    assert.equal(seen.length, 1, 'the NON_RETRYABLE_STREAM_ERROR regex still flags a refusal before the policy is asked');
});

test('step(): a first-event error that exhausts retries yields the last error event', async () => {
    const adapter = makeAdapter({ streams: [() => errorEventAtOpen({ event: malformed() }), () => errorEventAtOpen({ event: malformed() })] });
    const session =  (new StubSession({ adapter }).withRetryPolicy({ policy: new ExponentialBackoffPolicy({ maxRetries: 1, initialDelayMs: 1, maxDelayMs: 5, jitterMs: 0 }) }));

    /** @type {any[]} */
    const events =  ([]);
    const finalState = await collect({ gen: /** @type {any} */ (session).step({ messages: USER_MSG }), events });

    assert.equal(adapter.calls(), 2, 'one retry, then exhausted');
    assert.equal(events.filter((e) => e.type === 'error').length, 1,
        'exactly one error event is yielded (the last attempt)');
    assert.equal(finalState.streamError?.error_type, 'MALFORMED_FUNCTION_CALL');
});
