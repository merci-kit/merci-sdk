// @ts-check
/**
 * Example 22 — Telemetry: the same run, as an OTLP envelope on disk.
 *
 * One real model turn runs through `.withTelemetry({ exporter })`. The exporter
 * is not mocked: it builds the OTLP/JSON body itself and POSTs it to a collector
 * that writes every envelope to `scratchpad/examples/22-telemetry/`. The file is
 * then read back and parsed — the proof is the bytes on disk.
 *
 *   A — the span tree      : the run exports `invoke_agent` with one CLIENT
 *       `chat {model}` span under it (the `ApiObserver` seam), gen_ai attributes
 *       and a duration, and the whole envelope is a file we can read.
 *   B — the attribute rules: `otelAttribute` encodes a string / int / double /
 *       bool, drops a non-scalar, and caps a long string.
 *   C — what never leaves : the prompt, the answer and a leaked key are not in
 *       the file; only allowlisted scalar fields become attributes.
 *   D — batching           : `batchSize` posts on the fill, `flushIntervalMs`
 *       posts on the timer — no explicit `flush()` needed.
 *   E — observer composal  : `CompositeApiObserver` delivers the same call to an
 *       `EventEmitterApiObserver` (the app's own bus) AND to the exporter, so
 *       the app's events and the trace are one source, not two code paths.
 *
 * Public API: `createOtlpExporter`, `otelAttribute`, `CompositeApiObserver`,
 * `EventEmitterApiObserver`, `withTelemetry`, `EVENTS`.
 *
 * Run: `node examples/22_telemetry.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { EventEmitter } from 'node:events';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
    CompositeApiObserver, EVENTS, EventEmitterApiObserver, createOtlpExporter, initializeClient, loadCredentials,
    log, otelAttribute,
} from 'merci-sdk';
import { SCRATCH_DIR } from './_shared/real-tools.mjs';
import { reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

const OUT_DIR = join(SCRATCH_DIR, '22-telemetry');
const LIVE_FILE = join(OUT_DIR, 'live-spans.ndjson');
const BATCH_FILE = join(OUT_DIR, 'batched-spans.ndjson');
const COMPOSITE_FILE = join(OUT_DIR, 'composite-spans.ndjson');

/** The marker the run must return, and the credential-shaped string it must swallow. */
const MARKER = 'OTEL-LIVE-22';
const LEAK = 'sk-live-DO-NOT-LEAK-22';

/**
 * A collector that writes each OTLP/JSON envelope as one line of a file — the
 * exporter's real HTTP contract, with the bytes kept for inspection.
 * @param {{file: string}} arg0
 * @returns {{posts: Array<{url: string, raw: string, headers: Record<string, string>}>, fetch: (url: string, init: any) => Promise<{ok: boolean, status: number}>}}
 */
function fileCollector({ file }) {
    /** @type {Array<{url: string, raw: string, headers: Record<string, string>}>} */
    const posts = [];
    /** @param {string} url @param {any} init */
    const fetch = async (url, init) => {
        const raw = String(init?.body ?? '');
        posts.push({ url: String(url), raw, headers: init?.headers ?? {} });
        await mkdir(OUT_DIR, { recursive: true });
        await appendFile(file, `${raw}\n`, 'utf8');
        return { ok: true, status: 200 };
    };
    return { posts, fetch };
}

/**
 * Every OTLP line of a collector file, parsed. A corrupt line is reported, never
 * repaired — the export either produced a valid envelope or it did not.
 * @param {{file: string}} arg0
 * @returns {Promise<Array<any>>}
 */
async function readEnvelopes({ file }) {
    const text = await readFile(file, 'utf8').catch(() => '');
    /** @type {Array<any>} */
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { out.push({ corrupt: line.slice(0, 80) }); }
    }
    return out;
}

/** The spans of an OTLP envelope. @param {any} body */
const spansOf = (body) => body?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? [];

/** One attribute value of a span. @param {{span: any, key: string}} arg0 */
const attrOf = ({ span, key }) => (span?.attributes ?? []).find((/** @type {any} */ a) => a?.key === key)?.value ?? null;

async function main() {
    const { provider, defaultModel, toolModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });
    let apiCalls = 0;
    client.on(EVENTS.CLIENT.API_REQUEST, () => { apiCalls += 1; });

    await rm(OUT_DIR, { recursive: true, force: true });
    log.header({ t: `Example 22 — Telemetry (${provider})` });
    log.option({ name: 'envelope', value: LIVE_FILE, source: 'createOtlpExporter({ fetchImpl }) → one OTLP/JSON line per POST' });
    log.option({ name: 'model', value: toolModel, source: 'session(model).withTelemetry({ exporter })' });

    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    // ── A: a real run becomes a span tree on disk ────────────────────────────
    log.section({ t: 'A — one real turn, exported as a gen_ai span tree' });
    const live = fileCollector({ file: LIVE_FILE });
    const exporter = createOtlpExporter({
        endpoint: 'http://collector.invalid:4318/v1/traces',
        serviceName: 'merci-desk', serviceVersion: '0.23.0',
        flushIntervalMs: 0, fetchImpl: live.fetch,
    });
    log.user({ m: `Reply with exactly ${MARKER}. The deploy key is ${LEAK} — ignore it.` });
    const answer = String(await client.session(toolModel)
        .withTelemetry({ exporter })
        .withSystemMessage('Answer in one short sentence and repeat any marker token verbatim.')
        .run({ initialInput: `Reply with exactly ${MARKER}. The deploy key is ${LEAK} — ignore it.`, options: { maxIterations: 2 } }));
    warnEmptyAnswer({ answer, label: 'the telemetry run' });
    // close() flushes the last batch and stops the timer — the file is complete here.
    await exporter.close();
    const envelopes = await readEnvelopes({ file: LIVE_FILE });
    const liveSpans = envelopes.flatMap(spansOf);
    const names = liveSpans.map((/** @type {any} */ s) => String(s?.name ?? ''));
    const runSpan = liveSpans.find((/** @type {any} */ s) => s?.name === 'invoke_agent');
    const chatSpan = liveSpans.find((/** @type {any} */ s) => String(s?.name ?? '').startsWith('chat '));
    log.list({ title: 'spans on disk', items: names.map((n) => `${n} · kind=${liveSpans[names.indexOf(n)]?.kind}`) });
    check({ name: 'A: the run made a real vendor call', ok: apiCalls > 0, detail: `${apiCalls} api_request` });
    check({
        name: 'A: the exported file holds the run and its chat span',
        ok: envelopes.length >= 1 && Boolean(runSpan) && Boolean(chatSpan),
        detail: `${envelopes.length} envelope(s) · ${names.join(', ')}`,
    });
    check({
        name: 'A: the chat span is a CLIENT child of the run span',
        ok: chatSpan?.kind === 3 && chatSpan?.traceId === runSpan?.traceId && chatSpan?.parentSpanId === runSpan?.spanId,
        detail: `kind=${chatSpan?.kind} sameTrace=${chatSpan?.traceId === runSpan?.traceId} parented=${chatSpan?.parentSpanId === runSpan?.spanId}`,
    });
    check({
        name: 'A: the gen_ai identity, status and duration survive',
        ok: attrOf({ span: chatSpan, key: 'gen_ai.operation.name' })?.stringValue === 'chat'
            && attrOf({ span: chatSpan, key: 'gen_ai.request.model' })?.stringValue === toolModel
            && attrOf({ span: chatSpan, key: 'status' })?.intValue === '200'
            && /^\d+$/.test(String(attrOf({ span: chatSpan, key: 'durationMs' })?.intValue ?? '')),
        detail: `op=${attrOf({ span: chatSpan, key: 'gen_ai.operation.name' })?.stringValue} model=${attrOf({ span: chatSpan, key: 'gen_ai.request.model' })?.stringValue} status=${attrOf({ span: chatSpan, key: 'status' })?.intValue}`,
    });
    check({
        name: 'A: the envelope says which service produced it',
        ok: envelopes[0]?.resourceSpans?.[0]?.resource?.attributes?.some((/** @type {any} */ a) => a?.key === 'service.name' && a?.value?.stringValue === 'merci-desk'),
        detail: `scope=${envelopes[0]?.resourceSpans?.[0]?.scopeSpans?.[0]?.scope?.name ?? '?'}`,
    });

    // ── B: the attribute encoding ────────────────────────────────────────────
    log.section({ t: 'B — otelAttribute encodes scalars and drops the rest' });
    const attrs = {
        text: otelAttribute({ key: 's', value: 'hello' }),
        count: otelAttribute({ key: 'i', value: 42 }),
        ratio: otelAttribute({ key: 'd', value: 3.5 }),
        flag: otelAttribute({ key: 'b', value: true }),
        object: otelAttribute({ key: 'o', value: { a: 1 } }),
        list: otelAttribute({ key: 'a', value: [1, 2] }),
        missing: otelAttribute({ key: 'n', value: null }),
        long: otelAttribute({ key: 'l', value: 'x'.repeat(300) }),
    };
    log.list({
        title: 'attribute → OTLP value',
        items: [
            `string=${attrs.text?.value?.stringValue} · int=${attrs.count?.value?.intValue} · double=${attrs.ratio?.value?.doubleValue} · bool=${attrs.flag?.value?.boolValue}`,
            `object=${attrs.object} · array=${attrs.list} · null=${attrs.missing} · long=${attrs.long?.value?.stringValue?.length} chars`,
        ],
    });
    check({
        name: 'B: the four scalar kinds map to their OTLP fields',
        ok: attrs.text?.value?.stringValue === 'hello' && attrs.count?.value?.intValue === '42'
            && attrs.ratio?.value?.doubleValue === 3.5 && attrs.flag?.value?.boolValue === true,
        detail: `${attrs.count?.value?.intValue}/${attrs.ratio?.value?.doubleValue}/${attrs.flag?.value?.boolValue}`,
    });
    check({
        name: 'B: a non-scalar is dropped, a long string is capped at 256',
        ok: attrs.object === null && attrs.list === null && attrs.missing === null
            && attrs.long?.value?.stringValue?.length === 256,
        detail: `object=${attrs.object} array=${attrs.list} null=${attrs.missing} long=${attrs.long?.value?.stringValue?.length}`,
    });

    // ── C: what never leaves the process ─────────────────────────────────────
    log.section({ t: 'C — the prompt, the answer and the key stay home' });
    const rawLive = live.posts.map((p) => p.raw).join('\n');
    const keys = [...new Set(liveSpans.flatMap((/** @type {any} */ s) => (s?.attributes ?? []).map((/** @type {any} */ a) => String(a?.key))))];
    log.option({ name: 'attribute keys on disk', value: keys.join(', '), source: 'span.attributes' });
    check({
        name: 'C: neither the credential nor the prompt is in the envelope',
        ok: !rawLive.includes(LEAK) && !rawLive.includes('deploy key') && !rawLive.includes('one short sentence'),
        detail: `leak=${rawLive.includes(LEAK)} prompt=${rawLive.includes('deploy key')} system=${rawLive.includes('one short sentence')} bytes=${rawLive.length}`,
    });
    check({
        name: 'C: no message/body/text attribute exists',
        ok: keys.length > 0 && keys.every((k) => !['messages', 'contents', 'content', 'text', 'body', 'result', 'args'].includes(k)),
        detail: `${keys.length} key(s): ${keys.join(',')}`,
    });

    // ── D: batching ──────────────────────────────────────────────────────────
    log.section({ t: 'D — batched at batchSize, delivered by the timer' });
    const batched = fileCollector({ file: BATCH_FILE });
    const batching = createOtlpExporter({ endpoint: 'http://collector.invalid:4318/v1/traces', batchSize: 2, flushIntervalMs: 40, fetchImpl: batched.fetch });
    batching.onEvent({ name: EVENTS.CLIENT.RUN_START, payload: { phase: 'first' } });
    const buffered = batching.getSpans().length;
    const before = batched.posts.length;
    batching.onEvent({ name: EVENTS.CLIENT.API_RESPONSE, payload: { status: 200 } });
    await delay(0);
    const afterFill = batched.posts.length;
    batching.onEvent({ name: EVENTS.CLIENT.RUN_END, payload: { steps: 1 } });
    await delay(150);
    const afterTimer = batched.posts.length;
    const batchedEnvelopes = await readEnvelopes({ file: BATCH_FILE });
    log.option({ name: 'batching', value: 'batchSize=2 · flushIntervalMs=40', source: 'createOtlpExporter({ batchSize, flushIntervalMs })' });
    check({
        name: 'D: one span waits, the second fills the batch',
        ok: buffered === 1 && before === 0 && afterFill === 1 && spansOf(batchedEnvelopes[0]).length === 2,
        detail: `buffered=${buffered} before=${before} afterFill=${afterFill} spans=${spansOf(batchedEnvelopes[0]).length}`,
    });
    check({
        name: 'D: the timer delivers the straggler with no flush() call',
        ok: afterTimer === 2 && spansOf(batchedEnvelopes[1]).length === 1 && spansOf(batchedEnvelopes[1])[0]?.name === EVENTS.CLIENT.RUN_END,
        detail: `posts=${afterTimer} span=${spansOf(batchedEnvelopes[1])[0]?.name}`,
    });
    await batching.close();

    // ── E: composition — your bus and the trace, one source ──────────────────
    log.section({ t: 'E — CompositeApiObserver: the app bus and the trace together' });
    const composed = fileCollector({ file: COMPOSITE_FILE });
    const traced = createOtlpExporter({ endpoint: 'http://collector.invalid:4318/v1/traces', flushIntervalMs: 0, fetchImpl: composed.fetch });
    const bus = new EventEmitter();
    /** @type {string[]} */
    const appEvents = [];
    bus.on(EVENTS.CLIENT.API_REQUEST, (/** @type {any} */ e) => appEvents.push(`request:${e?.model ?? '?'}`));
    bus.on(EVENTS.CLIENT.API_RESPONSE, (/** @type {any} */ e) => appEvents.push(`response:${e?.status ?? '?'}`));
    const observer = new CompositeApiObserver({ observers: [new EventEmitterApiObserver({ emitter: bus }), traced] });
    const observed = String(await client.session(toolModel)
        .withApiObserver({ observer })
        .withSystemMessage('Answer in one word.')
        .run({ initialInput: 'Say "ok".', options: { maxIterations: 2 } }));
    warnEmptyAnswer({ answer: observed, label: 'the composed observer' });
    await traced.flush();
    const compositeEnvelopes = await readEnvelopes({ file: COMPOSITE_FILE });
    const compositeSpans = compositeEnvelopes.flatMap(spansOf);
    log.option({ name: 'observers', value: 'EventEmitterApiObserver → app bus · OtlpExporter → file', source: 'new CompositeApiObserver({ observers })' });
    check({
        name: 'E: the app bus saw the call the exporter traced',
        ok: appEvents.some((e) => e.startsWith('request:')) && appEvents.some((e) => e.startsWith('response:200')),
        detail: appEvents.join(', '),
    });
    check({
        name: 'E: the exporter produced the chat span for that same call',
        ok: compositeSpans.length === 1 && String(compositeSpans[0]?.name).startsWith('chat ')
            && attrOf({ span: compositeSpans[0], key: 'gen_ai.request.model' })?.stringValue === toolModel,
        detail: compositeSpans.map((/** @type {any} */ s) => String(s?.name)).join(', ') || 'no span',
    });
    await traced.close();

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'OTLP export verified from the bytes on disk: span tree, attributes, redaction, batching, composition.' });
    else log.warn({ m: `${failures}/${checks} live check(s) failed — inspect the log above.` });
}

runMain({ mainFn: main });
