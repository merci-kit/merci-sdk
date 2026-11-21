// provenance re-verification — phase 2 fixes (C + B)
// Each check was observed failing on the pre-fix tree before its fix landed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ExponentialBackoffPolicy } from '../lib/support/retry-policy.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { createOtlpExporter } from '../lib/support/otel-exporter.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

/** @param {Array<(msgs: any[]) => AsyncGenerator<any, any>>} script */
function scriptedSession(script) {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const ends = [];
    emitter.on(EVENTS.CLIENT.RUN_END, (e) => ends.push(e));
    let n = 0;
    return {
        ends,
        attempts: () => n,
        session: {
            provider: ProviderType.OPENAI,
            model: 'gpt-4o',
            eventEmitter: emitter,
            _tools: [],
            async *step({ messages }) {
                const body = script[Math.min(n, script.length - 1)];
                n += 1;
                return yield* body(messages);
            },
        },
    };
}

const quota = (/** @type {any} */ data) => ({ type: 'quota', data });
const done = (/** @type {any[]} */ messages) => ({ done: true, content: 'ok', messages });
const snapshot = (/** @type {any} */ e) => (e && typeof e === 'object' && e.data && typeof e.data === 'object' ? e.data : e);
const retryOnce = () => new ExponentialBackoffPolicy({ maxRetries: 1, initialDelayMs: 1, maxDelayMs: 2 });

test('B1: a retried attempt that reported usage is still charged', async () => {
    // The first attempt reported $0.50 and 10 tokens, then the transport threw.
    // Those tokens were spent at the vendor; dropping them under-reports spend and
    // lets a retry walk a token/USD budget past its cap.
    const { session, ends, attempts } = scriptedSession([
        async function* () {
            yield quota({ prompt_tokens: 10, completion_tokens: 0, cost_usd: 0.5 });
            throw Object.assign(new Error('transient 503'), { status: 503 });
        },
        async function* (messages) {
            yield quota({ prompt_tokens: 7, completion_tokens: 3, cost_usd: 0.25 });
            return done(messages);
        },
    ]);
    await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: { retryPolicy: retryOnce() } });

    assert.equal(attempts(), 2, 'the run retried once');
    const usage = snapshot(ends[0]).usage;
    assert.equal(usage.cost_usd, 0.75, 'both attempts are charged');
    assert.equal(usage.prompt_tokens, 17, 'tokens are summed across attempts');
    assert.equal(usage.completion_tokens, 3, 'completion tokens are summed across attempts');
});

test('B1: a run that fails on every attempt still reports what it spent', async () => {
    const { session, ends } = scriptedSession([
        async function* () {
            yield quota({ prompt_tokens: 10, completion_tokens: 2, cost_usd: 0.5 });
            throw Object.assign(new Error('transient 503'), { status: 503 });
        },
    ]);
    await assert.rejects(
        () => runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: { retryPolicy: retryOnce() } }),
        /transient 503/
    );
    const end = ends.at(-1);
    const usage = snapshot(end).usage;
    assert.equal(usage.cost_usd, 1, 'two failed attempts are both charged');
    assert.equal(usage.prompt_tokens, 20, 'their tokens are both counted');
});

test('B3: every span of one run shares one trace, and a child run links to its parent', async () => {
    /** @type {any[]} */
    const bodies = [];
    const exporter = createOtlpExporter({
        endpoint: 'http://otel.test/v1/traces',
        flushIntervalMs: 0,
        batchSize: 1000,
        fetchImpl: /** @type {any} */ (async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200 }; }),
    });
    exporter.onEvent({ name: 'run:start', payload: { runId: 'r1', event: 'run:start' } });
    exporter.onEvent({ name: 'step:start', payload: { runId: 'r1', event: 'step:start' } });
    exporter.onEvent({ name: 'run:start', payload: { runId: 'r2', parentRunId: 'r1', event: 'run:start' } });
    await exporter.flush();
    await exporter.close();
    const spans = bodies.flatMap((b) => b.resourceSpans[0].scopeSpans[0].spans);
    const byRun = (id) => spans.find((s) => s.attributes?.some((a) => a.key === 'runId' && a.value?.stringValue === id));
    assert.equal(new Set(spans.filter((s) => s.attributes?.some((a) => a.key === 'runId' && a.value?.stringValue === 'r1')).map((s) => s.traceId)).size, 1, 'one run, one trace');
    const parent = byRun('r1');
    const child = byRun('r2');
    assert.equal(child.traceId, parent.traceId, 'a child run stays in the parent trace');
    assert.equal(child.parentSpanId, parent.spanId, 'and points at the parent span');
});

test('B3: a correlated trace id is spec-shaped and a chat span joins the run trace', async () => {
    /** @type {any[]} */
    const bodies = [];
    const exporter = createOtlpExporter({
        endpoint: 'http://otel.test/v1/traces',
        flushIntervalMs: 0,
        batchSize: 1000,
        fetchImpl: /** @type {any} */ (async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200 }; }),
    });
    exporter.onEvent({ name: 'run:start', payload: { runId: 'r1', event: 'run:start' } });
    exporter.onRequest({ meta: { model: 'gpt-4o', messages: [], params: {} }, runContext: { runId: 'r1', parentRunId: null } });
    exporter.onResponse({ meta: { status: 200, ok: true } });
    await exporter.flush();
    await exporter.close();
    const spans = bodies.flatMap((b) => b.resourceSpans[0].scopeSpans[0].spans);
    const runSpan = spans.find((s) => s.name === 'invoke_agent');
    const apiSpan = spans.find((s) => s.kind === 3);
    assert.match(runSpan.traceId, /^[0-9a-f]{32}$/, 'an OTLP trace id is 16 bytes of hex');
    assert.match(runSpan.spanId, /^[0-9a-f]{16}$/, 'an OTLP span id is 8 bytes of hex');
    assert.equal(apiSpan.traceId, runSpan.traceId, 'the API call stays in the run trace');
    assert.equal(apiSpan.parentSpanId, runSpan.spanId, 'and points at the run span');
});
