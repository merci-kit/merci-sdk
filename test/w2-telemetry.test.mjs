// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createOtlpExporter, otelAttribute } from '../lib/support/otel-exporter.mjs';
import { CompositeApiObserver, EventEmitterApiObserver } from '../lib/support/api-observer.mjs';
import { MerciEventEmitter } from '../lib/core/emitter.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { NoRetryPolicy } from '../lib/support/retry-policy.mjs';

// ==================================================================================
// Helpers
// ==================================================================================

/**
 * A fake fetch that records every POST. Never touches the network.
 * @param {{fail?: boolean}} arg0
 */
function fakeFetch({ fail = false } = {}) {
    /** @type {Array<{url: string, init: any, body: any}>} */
    const calls = [];
    const impl = async (/** @type {string} */ url, /** @type {any} */ init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        if (fail) throw new Error('collector unreachable');
        return { ok: true, status: 200 };
    };
    return { calls, impl };
}

/**
 * @param {{attributes: any[], key: string}} arg0
 * @returns {any} The attribute value, or null when the key is absent.
 */
function attrValue({ attributes, key }) {
    const found = attributes.find((a) => a.key === key);
    return found ? found.value : null;
}

/**
 * @param {{span: any}} arg0
 * @returns {string[]} The attribute keys of the span.
 */
function spanNames({ span }) {
    return span.attributes.map((/** @type {any} */ a) => a.key);
}

// ==================================================================================
// otelAttribute
// ==================================================================================

test('otelAttribute encodes a string value', () => {
    assert.deepEqual(otelAttribute({ key: 'model', value: 'gpt-4o' }), {
        key: 'model', value: { stringValue: 'gpt-4o' }
    });
});

test('otelAttribute encodes an integer as an intValue string and a float as a doubleValue', () => {
    assert.deepEqual(otelAttribute({ key: 'status', value: 200 }), {
        key: 'status', value: { intValue: '200' }
    });
    assert.deepEqual(otelAttribute({ key: 'latency', value: 1.5 }), {
        key: 'latency', value: { doubleValue: 1.5 }
    });
});

test('otelAttribute encodes a boolean value', () => {
    assert.deepEqual(otelAttribute({ key: 'ok', value: true }), {
        key: 'ok', value: { boolValue: true }
    });
});

test('otelAttribute rejects non-scalar values and caps long strings', () => {
    assert.equal(otelAttribute({ key: 'messages', value: [{ role: 'user' }] }), null);
    assert.equal(otelAttribute({ key: 'err', value: new Error('x') }), null);
    assert.equal(otelAttribute({ key: 'nothing', value: null }), null);
    const long = 'x'.repeat(500);
    const attr = otelAttribute({ key: 'text', value: long });
    assert.equal(attr?.value.stringValue?.length, 256);
});

// ==================================================================================
// Event → span
// ==================================================================================

test('an event becomes a span with the event name and its scalar attributes', () => {
    const { impl } = fakeFetch();
    const exporter = createOtlpExporter({ fetchImpl: impl, flushIntervalMs: 0, batchSize: 100 });
    exporter.onEvent({ name: 'run:start', payload: { event: 'run:start', provider: 'openai', model: 'gpt-4o' } });

    const spans = exporter.getSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, 'run:start');
    assert.equal(attrValue({ attributes: spans[0].attributes, key: 'provider' }).stringValue, 'openai');
    assert.equal(attrValue({ attributes: spans[0].attributes, key: 'model' }).stringValue, 'gpt-4o');
    assert.match(spans[0].traceId, /^[0-9a-f]{32}$/);
    assert.match(spans[0].spanId, /^[0-9a-f]{16}$/);
    assert.match(spans[0].startTimeUnixNano, /^\d+$/);
    assert.match(spans[0].endTimeUnixNano, /^\d+$/);
    assert.equal(spans[0].status.code, 1);
});

test('a non-scalar payload field is not leaked into the attributes', () => {
    const { impl } = fakeFetch();
    const exporter = createOtlpExporter({ fetchImpl: impl, flushIntervalMs: 0, batchSize: 100 });
    exporter.onEvent({
        name: 'api_request',
        payload: {
            event: 'api_request',
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'secret prompt' }],
            body: '{"secret":true}',
            headers: { authorization: 'Bearer x' }
        }
    });

    const spans = exporter.getSpans();
    const keys = spanNames({ span: spans[0] });
    assert.ok(!keys.includes('messages'), 'message history must not be exported');
    assert.ok(!keys.includes('body'), 'request body must not be exported');
    assert.ok(!keys.includes('headers'), 'headers must not be exported');
    assert.ok(keys.includes('model'));
});

// ==================================================================================
// Batching + OTLP envelope
// ==================================================================================

test('the batch flushes at the batch size and posts the OTLP envelope', async () => {
    const { calls, impl } = fakeFetch();
    const exporter = createOtlpExporter({
        endpoint: 'http://collector.test/v1/traces',
        serviceName: 'my-app',
        serviceVersion: '1.2.3',
        resourceAttributes: { 'deployment.environment': 'test' },
        headers: { 'x-api-key': 'k' },
        fetchImpl: impl,
        flushIntervalMs: 0,
        batchSize: 2
    });

    exporter.onEvent({ name: 'run:start', payload: { event: 'run:start' } });
    assert.equal(calls.length, 0, 'no POST before the batch is full');
    exporter.onEvent({ name: 'run:end', payload: { event: 'run:end' } });

    assert.equal(calls.length, 1, 'the batch size triggers exactly one POST');
    assert.equal(calls[0].url, 'http://collector.test/v1/traces');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.equal(calls[0].init.headers['x-api-key'], 'k');

    const body = calls[0].body;
    const resourceSpans = body.resourceSpans[0];
    assert.equal(resourceSpans.scopeSpans[0].spans.length, 2);
    assert.equal(resourceSpans.scopeSpans[0].spans[0].name, 'run:start');
    assert.equal(resourceSpans.scopeSpans[0].spans[1].name, 'run:end');
    assert.equal(resourceSpans.scopeSpans[0].scope.name, 'merci-sdk');

    const resourceKeys = resourceSpans.resource.attributes.map((/** @type {any} */ a) => a.key);
    assert.ok(resourceKeys.includes('service.name'));
    assert.ok(resourceKeys.includes('service.version'));
    assert.ok(resourceKeys.includes('deployment.environment'));
    const serviceName = resourceSpans.resource.attributes.find((/** @type {any} */ a) => a.key === 'service.name');
    assert.equal(serviceName.value.stringValue, 'my-app');
    const serviceVersion = resourceSpans.resource.attributes.find((/** @type {any} */ a) => a.key === 'service.version');
    assert.equal(serviceVersion.value.stringValue, '1.2.3');

    assert.equal(exporter.getSpans().length, 0, 'a flushed batch is no longer buffered');
    await exporter.close();
});

test('flush posts the buffered spans and close stops the timer', async () => {
    const { calls, impl } = fakeFetch();
    const exporter = createOtlpExporter({ fetchImpl: impl, flushIntervalMs: 5, batchSize: 100 });
    exporter.onEvent({ name: 'run:start', payload: { event: 'run:start' } });
    await exporter.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.resourceSpans[0].scopeSpans[0].spans.length, 1);
    await exporter.close();
});

// ==================================================================================
// Failure policy
// ==================================================================================

test('a failing POST is swallowed, warns and never breaks the emitter', async () => {
    /** @type {any[]} */
    const rejections = [];
    const onRejection = (/** @type {any} */ reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);

    const { impl } = fakeFetch({ fail: true });
    const exporter = createOtlpExporter({ fetchImpl: impl, flushIntervalMs: 0, batchSize: 1 });
    const emitter = new MerciEventEmitter();
    const detach = exporter.attach({ emitter });

    assert.doesNotThrow(() => {
        emitter.emit('run:start', { event: 'run:start', provider: 'openai' });
    });

    await exporter.flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off('unhandledRejection', onRejection);

    assert.deepEqual(rejections, [], 'a failed export must not reject anywhere');
    detach();
    await exporter.close();
});

test('a non-OK response is swallowed as well', async () => {
    const impl = async () => ({ ok: false, status: 503 });
    const exporter = createOtlpExporter({ fetchImpl: impl, flushIntervalMs: 0, batchSize: 100 });
    exporter.onEvent({ name: 'run:start', payload: { event: 'run:start' } });
    await assert.doesNotReject(() => exporter.flush());
    await exporter.close();
});

// ==================================================================================
// ApiObserver path
// ==================================================================================

test('an API call becomes one span carrying its duration', () => {
    const { impl } = fakeFetch();
    const exporter = createOtlpExporter({ fetchImpl: impl, flushIntervalMs: 0, batchSize: 100 });
    exporter.onRequest({ meta: { model: 'gpt-4o' } });
    exporter.onResponse({ meta: { status: 200, ok: true, durationMs: 42 } });

    const spans = exporter.getSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, 'chat gpt-4o');
    assert.equal(spans[0].kind, 3);
    assert.equal(spans[0].status.code, 1);
    assert.equal(attrValue({ attributes: spans[0].attributes, key: 'status' }).intValue, '200');
    assert.equal(attrValue({ attributes: spans[0].attributes, key: 'durationMs' }).intValue, '42');
    assert.equal(attrValue({ attributes: spans[0].attributes, key: 'model' }).stringValue, 'gpt-4o');
    assert.ok(BigInt(spans[0].endTimeUnixNano) >= BigInt(spans[0].startTimeUnixNano));
});

test('an API error becomes an error-status span', () => {
    const { impl } = fakeFetch();
    const exporter = createOtlpExporter({ fetchImpl: impl, flushIntervalMs: 0, batchSize: 100 });
    exporter.onRequest({ meta: { model: 'gpt-4o' } });
    exporter.onError({ meta: { error: new Error('boom') } });

    const spans = exporter.getSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, 'chat gpt-4o');
    assert.equal(spans[0].status.code, 2);
    assert.equal(attrValue({ attributes: spans[0].attributes, key: 'error.type' }).stringValue, 'Error');
    assert.equal(attrValue({ attributes: spans[0].attributes, key: 'error.message' }), null, 'the message is free text and stays out');
});

test('the API call is not counted twice when the exporter is both observer and listener', () => {
    const { impl } = fakeFetch();
    const exporter = createOtlpExporter({ fetchImpl: impl, flushIntervalMs: 0, batchSize: 100 });
    exporter.onRequest({ meta: { model: 'gpt-4o' } });
    exporter.onEvent({ name: 'api_request', payload: { event: 'api_request', model: 'gpt-4o' } });
    exporter.onResponse({ meta: { status: 200, ok: true, durationMs: 5 } });
    exporter.onEvent({ name: 'api_response', payload: { event: 'api_response', status: 200 } });

    const spans = exporter.getSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, 'chat gpt-4o');
});

test('CompositeApiObserver notifies every observer and isolates a throwing one', () => {
    const emitter = new EventEmitter();
    /** @type {any} */
    let seen = null;
    const composite = new CompositeApiObserver({
        observers: [
            new EventEmitterApiObserver({ emitter }),
            {
                /** @param {{meta: any}} arg0 */
                onRequest({ meta }) { seen = meta; }
            },
            { onRequest() { throw new Error('observer exploded'); } }
        ]
    });

    assert.doesNotThrow(() => composite.onRequest({ meta: { model: 'gpt-4o' } }));
    assert.deepEqual(seen, { model: 'gpt-4o' });
});

// ==================================================================================
// API-span pairing through a real session step (0.7.3 item A)
// ==================================================================================

class PairingSession extends AbstractChatSession {
    /** @param {{model: string, exporter: any, adapter: any}} arg0 */
    constructor({ model, exporter, adapter }) {
        super({ provider: ProviderType.OPENAI, model, eventEmitter: new EventEmitter(), client: /** @type {any} */ ({ session() {} }), apiObserver: exporter, retryPolicy: new NoRetryPolicy() });
        this._streamTimeoutPolicy = /** @type {any} */ ({});
        this._adapter = adapter;
    }
}

/**
 * A fake adapter: `open` decides how the vendor call goes; the stream yields one text event.
 * @param {{open: (arg0: {signal: AbortSignal}) => Promise<void>}} arg0
 */
function pairingAdapter({ open }) {
    return {
        vendorName: 'FAKE',
        buildVendorRequest: (/** @type {any} */ { model }) => ({ request: {}, observability: { model } }),
        executeVendorRequest: async (/** @type {any} */ { signal }) => {
            await open({ signal });
            return (async function* () { yield { type: 'text', content: 'ok' }; })();
        },
        consumeStream: (/** @type {{rawStream: any}} */ { rawStream }) => rawStream,
        formatToolCall: (/** @type {{call: any}} */ { call }) => call,
    };
}

/** @param {{session: any, signal?: AbortSignal}} arg0 */
async function drainStep({ session, signal }) {
    const gen = session.step({ messages: [{ role: 'user', content: 'hi' }], options: signal ? { signal } : {} });
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    return r.value;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {(arg0: {signal: AbortSignal}) => void} onAbort */
const untilAborted = (onAbort) => (/** @type {{signal: AbortSignal}} */ { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { onAbort({ signal }); reject(signal.reason); }, { once: true });
});

test('A: an aborted call ends its own span; the next call keeps its start time and model', async () => {
    const exporter = createOtlpExporter({ fetchImpl: fakeFetch().impl, flushIntervalMs: 0, batchSize: 100 });
    let mode = 'hang';
    const adapter = pairingAdapter({ open: (arg) => (mode === 'hang' ? untilAborted(() => {})(arg) : Promise.resolve()) });
    const aborted = new PairingSession({ model: 'm1', exporter, adapter });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('user cancel')), 10);
    await assert.rejects(() => drainStep({ session: aborted, signal: controller.signal }));

    await sleep(30);
    mode = 'ok';
    const secondStartNs = BigInt(Date.now()) * 1_000_000n;
    await drainStep({ session: new PairingSession({ model: 'm2', exporter, adapter }) });

    const spans = exporter.getSpans().filter((s) => s.name.startsWith('chat'));
    assert.equal(spans.length, 2, 'one span per call');
    const [first, second] = spans;
    assert.equal(attrValue({ attributes: first.attributes, key: 'model' }).stringValue, 'm1');
    assert.equal(first.status.code, 2, 'the cancelled call ends with an error status');
    assert.equal(attrValue({ attributes: first.attributes, key: 'aborted' }).boolValue, true);
    assert.equal(attrValue({ attributes: second.attributes, key: 'model' }).stringValue, 'm2', 'not the aborted call\'s model');
    assert.ok(BigInt(second.startTimeUnixNano) >= secondStartNs, 'not the aborted call\'s start time');
});

test('A: two sessions on one exporter interleave and still pair correctly', async () => {
    const exporter = createOtlpExporter({ fetchImpl: fakeFetch().impl, flushIntervalMs: 0, batchSize: 100 });
    // slow opens first and answers last; fast opens second and answers first.
    const slow = new PairingSession({ model: 'slow', exporter, adapter: pairingAdapter({ open: () => sleep(40) }) });
    const fast = new PairingSession({ model: 'fast', exporter, adapter: pairingAdapter({ open: () => sleep(5) }) });
    const slowRun = drainStep({ session: slow });
    await sleep(2);
    await Promise.all([slowRun, drainStep({ session: fast })]);

    const spans = exporter.getSpans().filter((s) => s.name.startsWith('chat'));
    assert.equal(spans.length, 2);
    for (const span of spans) {
        const model = attrValue({ attributes: span.attributes, key: 'model' }).stringValue;
        const durationMs = Number(attrValue({ attributes: span.attributes, key: 'durationMs' }).intValue);
        const spanMs = Number((BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000n);
        assert.ok(model === 'slow' ? spanMs >= 35 : spanMs < 35, `${model}: span bounds come from its own request (${spanMs}ms)`);
        assert.ok(Math.abs(spanMs - durationMs) <= 5, `${model}: span bounds match the call's duration`);
    }
});

test('A: one failed call produces exactly one span, carrying the error', async () => {
    const exporter = createOtlpExporter({ fetchImpl: fakeFetch().impl, flushIntervalMs: 0, batchSize: 100 });
    const adapter = pairingAdapter({ open: async () => { throw Object.assign(new Error('bad request'), { status: 400 }); } });
    await assert.rejects(() => drainStep({ session: new PairingSession({ model: 'm', exporter, adapter }) }), /bad request/);

    const spans = exporter.getSpans().filter((s) => s.name.startsWith('chat'));
    assert.equal(spans.length, 1, 'one failure, one span');
    assert.equal(spans[0].status.code, 2);
    assert.equal(attrValue({ attributes: spans[0].attributes, key: 'error.type' }).stringValue, 'Error');
    assert.equal(attrValue({ attributes: spans[0].attributes, key: 'error.message' }), null, 'the message is free text and stays out');
    assert.equal(attrValue({ attributes: spans[0].attributes, key: 'status' }).intValue, '400');
});

test('A: the default observer still reports a failed call as api_response then api_error', () => {
    const emitter = new EventEmitter();
    /** @type {string[]} */
    const seen = [];
    emitter.on('api_response', (/** @type {any} */ e) => seen.push(`response:${e.ok}:${e.status}`));
    emitter.on('api_error', (/** @type {any} */ e) => seen.push(`error:${e.message}`));
    new EventEmitterApiObserver({ emitter }).onError({ meta: { error: new Error('x'), status: 500, ok: false, durationMs: 3 } });
    assert.deepEqual(seen, ['response:false:500', 'error:x']);
});

test('A: onError with nothing open makes no span', () => {
    const exporter = createOtlpExporter({ fetchImpl: fakeFetch().impl, flushIntervalMs: 0, batchSize: 100 });
    exporter.onError({ meta: { error: new Error('late') } });
    assert.equal(exporter.getSpans().length, 0);
});

test('G: a stream that fails midway ends its one chat span with the error', async () => {
    const exporter = createOtlpExporter({ fetchImpl: fakeFetch().impl, flushIntervalMs: 0, batchSize: 100 });
    const adapter = {
        ...pairingAdapter({ open: async () => {} }),
        executeVendorRequest: async () => (async function* () {
            yield { type: 'text', content: 'par' };
            throw new Error('boom mid-stream');
        })(),
    };
    await assert.rejects(() => drainStep({ session: new PairingSession({ model: 'm', exporter, adapter }) }), /boom mid-stream/);
    const spans = exporter.getSpans().filter((s) => s.kind === 3);
    assert.equal(spans.length, 1, 'one call, one span');
    assert.equal(spans[0].name, 'chat m');
    assert.equal(spans[0].status.code, 2);
    assert.equal(attrValue({ attributes: spans[0].attributes, key: 'error.type' }).stringValue, 'Error');
    assert.equal(attrValue({ attributes: spans[0].attributes, key: 'error.message' }), null, 'the message is free text and stays out');
});

test('G: the observer hears a call end after the request:after chain, on success and on failure', async () => {
    const { createHooks, HOOKS } = await import('../lib/core/hooks.mjs');
    /** @type {string[]} */
    const order = [];
    const observer = {
        onRequest() {},
        onResponse() { order.push('observer'); },
        onError() { order.push('observer'); },
    };
    const hooks = createHooks();
    hooks.add({ name: HOOKS.REQUEST_AFTER, fn: async () => { order.push('hook'); } });
    for (const fail of [false, true]) {
        const adapter = pairingAdapter({ open: async () => { if (fail) throw Object.assign(new Error('bad'), { status: 400 }); } });
        const session = /** @type {any} */ (new PairingSession({ model: 'm', exporter: observer, adapter }));
        session.withHooks({ hooks });
        const run = drainStep({ session });
        if (fail) await assert.rejects(run); else await run;
    }
    assert.deepEqual(order, ['hook', 'observer', 'hook', 'observer']);
});

test('G: a run exports a gen_ai span tree — invoke_agent > chat / execute_tool, with durations and usage', async () => {
    const { runAgenticLoop } = await import('../lib/agentic/agentic-core.mjs');
    const exporter = createOtlpExporter({ fetchImpl: fakeFetch().impl, flushIntervalMs: 0, batchSize: 1000 });
    let call = 0;
    const adapter = {
        ...pairingAdapter({ open: async () => {} }),
        executeVendorRequest: async () => {
            call += 1;
            const round = call;
            await sleep(5);
            return (async function* () {
                await sleep(5);
                if (round === 1) {
                    yield { type: 'quota', data: { prompt_tokens: 11, completion_tokens: 3 } };
                    yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'lookup', args: {} }] };
                } else {
                    yield { type: 'text', content: 'done' };
                    yield { type: 'quota', data: { prompt_tokens: 20, completion_tokens: 4 } };
                }
            })();
        },
    };
    const session = /** @type {any} */ (new AbstractChatSession({ provider: ProviderType.OPENAI, model: 'gpt-x', eventEmitter: new EventEmitter(), client: /** @type {any} */ ({ session() {} }), retryPolicy: new NoRetryPolicy() }));
    session._streamTimeoutPolicy = {};
    session._adapter = adapter;
    session.withTools({ tools: [{ name: 'lookup', description: 'l', parameters: { type: 'object', properties: {} }, execute: async () => { await sleep(5); return 'found'; } }] });
    session.withTelemetry({ exporter });
    const out = await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] });
    assert.equal(out, 'done');
    const spans = /** @type {any[]} */ (exporter.getSpans());
    await exporter.close();
    const agent = spans.find((s) => s.name === 'invoke_agent');
    const chats = spans.filter((s) => s.name === 'chat gpt-x');
    const tool = spans.find((s) => s.name === 'execute_tool lookup');
    assert.ok(agent && tool, `the tree's nodes exist: ${spans.map((s) => s.name).join(', ')}`);
    assert.equal(chats.length, 2, 'one chat span per vendor call');
    for (const child of [...chats, tool]) {
        assert.equal(child.traceId, agent.traceId, `${child.name} is in the run's trace`);
        assert.equal(child.parentSpanId, agent.spanId, `${child.name} hangs off invoke_agent`);
    }
    for (const span of [agent, ...chats, tool]) {
        assert.ok(BigInt(span.endTimeUnixNano) > BigInt(span.startTimeUnixNano), `${span.name} has a duration`);
    }
    const a = (/** @type {any} */ span, /** @type {string} */ key) => attrValue({ attributes: span.attributes, key });
    assert.equal(chats[0].kind, 3, 'a vendor call is a CLIENT span');
    assert.equal(a(chats[0], 'gen_ai.operation.name').stringValue, 'chat');
    assert.equal(a(chats[0], 'gen_ai.provider.name').stringValue, 'openai');
    assert.equal(a(chats[0], 'gen_ai.request.model').stringValue, 'gpt-x');
    assert.equal(a(chats[0], 'gen_ai.usage.input_tokens').intValue, '11');
    assert.equal(a(chats[1], 'gen_ai.usage.output_tokens').intValue, '4');
    assert.equal(a(tool, 'gen_ai.operation.name').stringValue, 'execute_tool');
    assert.equal(a(tool, 'gen_ai.tool.name').stringValue, 'lookup', 'a tool span names its tool');
    assert.ok(a(tool, 'gen_ai.tool.call.id')?.stringValue || a(tool, 'gen_ai.tool.call.id')?.intValue, 'and keeps the call id');
    assert.equal(a(agent, 'gen_ai.operation.name').stringValue, 'invoke_agent');
    assert.equal(a(agent, 'gen_ai.usage.input_tokens').intValue, '31', 'the run sums its calls');
    assert.ok((chats[0].events ?? []).some((/** @type {any} */ e) => e.name === 'api_stream_start'), 'stream events are span events on the call');
    assert.equal(spans.some((s) => s.name === 'api_stream_start' || s.name === 'tool:call_start'), false, 'not spans of their own');
    assert.equal((agent.events ?? []).some((/** @type {any} */ e) => e.name === 'api_request'), false, 'the observer path owns api_request, even on the first call');
    assert.equal(JSON.stringify(spans).includes('"go"'), false, 'prompt content stays out');
});

test('G review: a tool call cut off by an abort ends with its run; a run that threw is an error', () => {
    const exporter = createOtlpExporter({ fetchImpl: fakeFetch().impl, flushIntervalMs: 0, batchSize: 100000 });
    exporter.onEvent({ name: 'run:start', payload: { runId: 'R' } });
    exporter.onEvent({ name: 'tool:call_start', payload: { runId: 'R', id: 'c1', name: 'slow' } });
    exporter.onEvent({ name: 'run:end', payload: { runId: 'R', finishReason: 'budget', failed: true } });
    const spans = exporter.getSpans();
    const tool = spans.find((s) => s.name === 'execute_tool slow');
    const run = spans.find((s) => s.name === 'invoke_agent');
    assert.ok(tool, 'the tool span is exported with its run');
    assert.equal(tool.status.code, 2);
    assert.equal(run?.status.code, 2, 'a budget stop that threw to the caller is a failed run');
});

test('G review: an open run stays a parent past the index bound; an evicted open span is still exported', () => {
    const exporter = createOtlpExporter({ fetchImpl: fakeFetch().impl, flushIntervalMs: 0, batchSize: 100000 });
    exporter.onEvent({ name: 'run:start', payload: { runId: 'R' } });
    for (let i = 0; i < 4100; i++) exporter.onEvent({ name: 'loose', payload: { runId: `loose-${i}` } });
    exporter.onRequest({ meta: { model: 'm' }, runContext: /** @type {any} */ ({ runId: 'S', parentRunId: 'R' }) });
    exporter.onResponse({ meta: { ok: true }, runContext: /** @type {any} */ ({ runId: 'S', parentRunId: 'R' }) });
    exporter.onEvent({ name: 'run:end', payload: { runId: 'R' } });
    const spans = exporter.getSpans();
    const run = spans.find((s) => s.name === 'invoke_agent');
    const chat = spans.find((s) => s.name === 'chat m');
    assert.equal(chat?.parentSpanId, run?.spanId, 'still parented to its open run');
    assert.equal(chat?.traceId, run?.traceId);

    const bounded = createOtlpExporter({ fetchImpl: fakeFetch().impl, flushIntervalMs: 0, batchSize: 100000 });
    for (let i = 0; i < 4097; i++) bounded.onEvent({ name: 'run:start', payload: { runId: `r${i}` } });
    const evicted = bounded.getSpans().filter((s) => s.name === 'invoke_agent');
    assert.equal(evicted.length, 1, 'the evicted open run is exported, not dropped');
    assert.equal(evicted[0].status.code, 0, 'as UNSET');
});
