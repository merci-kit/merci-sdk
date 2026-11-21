// @ts-check
/**
 * Example 21 — Observability: correlation, custom observers, typed errors, abort.
 *
 *   1–3 — deterministic, NO provider: the `{ runId, parentRunId, sessionId, ts }`
 *          envelope (`RunContext`/`stampEvent`/`stampStreamEvent`), a custom
 *          `EventEmitterApiObserver` driven by hand, and the typed-error layer
 *          (`isAbortError`, `wrapError` → `AbortedError` / `BackendError`).
 *   4–7 — LIVE (needs a backend): subscribe to the client event families and
 *          read the run→step correlation trail; route one session through a
 *          custom observer via `.withApiObserver({ observer })`; watch an
 *          unknown model become a typed `BackendError`; abort a run and collect
 *          the `aborted` event.
 *
 * Public API: `EVENTS`, `RunContext`, `stampEvent`, `stampStreamEvent`,
 * `EventEmitterApiObserver`, `BackendError`, `AbortedError`, `isAbortError`,
 * `wrapError`, `.withApiObserver({ observer })`, `MerciEventEmitter`,
 * `createHooks`, `STOP`, `PHASES`, `enterPhase`.
 *
 * Run: `node examples/21_observability.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env` (only for sections 4–7).
 *
 * @version 0.23.0
 */
import { EventEmitter } from 'node:events';
import {
    AbortedError, BackendError, ProviderType, EVENTS, EventEmitterApiObserver, MerciEventEmitter,
    PHASES, RunContext, STOP, createHooks, enterPhase,
    initializeClient, isAbortError, loadCredentials, log, stampEvent, stampStreamEvent, wrapError,
} from 'merci-sdk';
import { resolveExample, reportUsage, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

let failures = 0;
/** @param {{name: string, passed: boolean, detail?: string}} arg0 */
function check({ name, passed, detail }) {
    if (!passed) failures += 1;
    log.check({ name, passed, detail });
}

/** @param {unknown} id - An envelope field (runId, parentRunId, …). */
const short = (id) => String(id ?? '—').slice(0, 8);

async function main() {
    log.header({ t: 'Example 21 — Observability' });

    // ── 1 · correlation envelope (deterministic, no backend) ─────────────────
    log.section({ t: '1 · { runId, parentRunId, sessionId, ts }' });
    const parent = new RunContext({ sessionId: 'observability-demo' });
    const child = RunContext.child(parent);
    const rootEvent = parent.wrap({ name: EVENTS.CLIENT.RUN_START, payload: { provider: 'demo', model: 'demo' } });
    const childEvent = child.wrap({ name: EVENTS.CLIENT.API_REQUEST, payload: { model: 'demo' } });
    const streamed = stampStreamEvent({ event: { type: 'text', content: 'hi' }, runContext: child });
    const standalone = stampEvent({ name: EVENTS.CLIENT.WARNING, payload: { message: 'demo' }, runContext: child });
    check({ name: 'root event: parentRunId is null', passed: rootEvent.runId === parent.runId && rootEvent.parentRunId === null && rootEvent.sessionId === 'observability-demo', detail: `runId=${short(rootEvent.runId)} parentRunId=${rootEvent.parentRunId}` });
    check({ name: 'child event points at the parent run', passed: childEvent.runId === child.runId && childEvent.parentRunId === parent.runId, detail: `${short(childEvent.runId)} → parent ${short(childEvent.parentRunId)}` });
    check({ name: 'stream events gain runId + ts, keep their type', passed: streamed.type === 'text' && streamed.runId === child.runId && typeof streamed.ts === 'number', detail: `type=${streamed.type} runId=${short(streamed.runId)} ts=${streamed.ts}` });
    check({ name: 'stampEvent wraps outside a run', passed: standalone.event === EVENTS.CLIENT.WARNING && standalone.parentRunId === parent.runId, detail: `event=${standalone.event} parent=${short(standalone.parentRunId)}` });

    // ── 2 · custom observer, driven by hand (deterministic, no backend) ──────
    log.section({ t: '2 · EventEmitterApiObserver → your own emitter' });
    const bus = new EventEmitter();
    const seen = { requests: /** @type {any[]} */ ([]), responses: /** @type {any[]} */ ([]), retries: /** @type {any[]} */ ([]), errors: /** @type {any[]} */ ([]) };
    bus.on(EVENTS.CLIENT.API_REQUEST, (m) => seen.requests.push(m));
    bus.on(EVENTS.CLIENT.API_RESPONSE, (m) => seen.responses.push(m));
    bus.on(EVENTS.CLIENT.API_RETRY, (m) => seen.retries.push(m));
    bus.on('error', (err) => seen.errors.push(err));
    const observer = new EventEmitterApiObserver({ emitter: bus });
    observer.onRequest({ meta: { model: 'demo-model', messages: [{ role: 'user', content: 'hi' }], params: { temperature: 0.2 } }, runContext: null });
    observer.onResponse({ meta: { status: 200, ok: true }, runContext: null });
    observer.onRetry({ meta: { vendor: 'demo', attempt: 1, nextDelayMs: 250, error: new Error('connection reset by peer') } });
    observer.setRunContext({ runContext: child });
    observer.onRequest({ meta: { model: 'demo-model' }, runContext: null });
    observer.onError({ meta: { error: new Error('demo failure') } });
    check({ name: 'observer mapped request/response/retry/error', passed: seen.requests.length === 2 && seen.responses.length === 1 && seen.retries.length === 1 && seen.errors.length === 1, detail: `requests=${seen.requests.length} responses=${seen.responses.length} retries=${seen.retries.length} errors=${seen.errors.length}` });
    check({ name: 'setRunContext stamps later calls', passed: seen.requests[1]?.runId === child.runId && seen.requests[1]?.parentRunId === parent.runId, detail: `runId=${short(seen.requests[1]?.runId)} parent=${short(seen.requests[1]?.parentRunId)}` });

    // ── 3 · typed errors (deterministic, no backend) ─────────────────────────
    log.section({ t: '3 · typed errors: isAbortError + wrapError' });
    const abortShaped = Object.assign(new Error('observer pressed stop'), { name: 'AbortError' });
    check({ name: 'isAbortError detects abort-shaped errors', passed: isAbortError({ err: abortShaped }) && !isAbortError({ err: new Error('boom') }), detail: `abort=${isAbortError({ err: abortShaped })} plain=${isAbortError({ err: new Error('boom') })}` });
    const wrappedAbort = wrapError({ err: abortShaped });
    check({ name: 'wrapError → AbortedError', passed: wrappedAbort instanceof AbortedError, detail: wrappedAbort.name });
    const vendorErr = Object.assign(new Error('model `no-such-model` not found'), { status: 404, code: 'model_not_found' });
    const wrappedVendor = /** @type {any} */ (wrapError({ err: vendorErr, hints: { provider: 'demo' } }));
    check({ name: 'wrapError → BackendError when the vendor carried a status', passed: wrappedVendor instanceof BackendError && wrappedVendor.status === 404 && wrappedVendor.provider === 'demo', detail: `${wrappedVendor.name} status=${wrappedVendor.status} backend=${wrappedVendor.provider}` });
    check({ name: 'wrapError passes MerciErrors through unchanged', passed: wrapError({ err: wrappedVendor }) === wrappedVendor, detail: 'same instance' });

    // ── 3b · phases, hooks, and a wildcard emitter (deterministic, no backend) ─
    log.section({ t: '3b · phases + hooks + MerciEventEmitter' });
    const wild = new MerciEventEmitter({ strict: true });
    /** @type {string[]} */
    const phaseTrail = [];
    /** @type {string[]} */
    const unhandled = [];
    wild.on('phase:*', (/** @type {any} */ e) => phaseTrail.push(`${e.phase}:${e.status ?? 'start'}`));
    wild.on(EVENTS.ERRORS.UNHANDLED, (/** @type {any} */ e) => unhandled.push(e.event));
    const phased = await enterPhase({ ctx: { emitter: wild }, phase: PHASES.STEP, fn: async () => 7 });
    wild.emit('nobody:listens', {});
    check({ name: 'phase:* glob sees the step umbrella (start + end)', passed: phased === 7 && phaseTrail.length === 2 && phaseTrail[0] === 'step:start' && phaseTrail[1] === 'step:success', detail: phaseTrail.join(' → ') });
    check({ name: 'strict emitter surfaces event:unhandled', passed: unhandled.length === 1 && unhandled[0] === 'nobody:listens', detail: unhandled.join(', ') });

    const hooks = createHooks();
    /** @type {string[]} */
    const hookOrder = [];
    hooks.add({ name: 'demo', fn: (/** @type {any} */ v) => { hookOrder.push('low'); return v + 1; }, priority: 1 });
    hooks.add({ name: 'demo', fn: (/** @type {any} */ v) => { hookOrder.push('high'); return v + 10; }, priority: 10 });
    hooks.add({ name: 'demo', fn: () => STOP });
    const hooked = await hooks.runWaterfall({ name: 'demo', value: 0 });
    check({ name: 'hooks run in priority order; STOP vetoes', passed: hooked === STOP && hookOrder.join(',') === 'high,low', detail: `order=${hookOrder.join(' → ')} veto=${hooked === STOP}` });

    // ══ LIVE sections 4–7 (need a backend) ══════════════════════════════════
    const { provider, defaultModel } = resolveExample();
    log.header({ t: `Example 21 — Live observability (${provider})` });
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    // ── 4 · event families + run→step correlation ────────────────────────────
    log.section({ t: '4 · client event families in a live run' });
    /** @type {Array<{event: string, runId: string|null, parentRunId: string|null}>} */
    const trail = [];
    const TRACKED = [
        EVENTS.CLIENT.RUN_START, EVENTS.CLIENT.SESSION_STEP_START, EVENTS.CLIENT.API_REQUEST,
        EVENTS.CLIENT.STREAM_FIRST_TOKEN, EVENTS.CLIENT.API_RESPONSE, EVENTS.CLIENT.SESSION_STEP_END, EVENTS.CLIENT.RUN_END,
    ];
    for (const name of TRACKED) client.on(name, (/** @type {any} */ e) => trail.push({ event: e?.event ?? name, runId: e?.runId ?? null, parentRunId: e?.parentRunId ?? null }));
    const answer = await client.session(defaultModel)
        .withSystemMessage('Answer in one short sentence.')
        .run({ initialInput: 'Name the capital of France.', options: { maxIterations: 2 } });
    log.assistant({ m: String(answer) });
    warnEmptyAnswer({ answer, label: 'the correlation run' });
    const root = trail.find((e) => e.event === EVENTS.CLIENT.RUN_START);
    const stepChild = trail.find((e) => e.event === EVENTS.CLIENT.SESSION_STEP_START);
    const apiCall = trail.find((e) => e.event === EVENTS.CLIENT.API_REQUEST);
    log.list({ title: 'event trail · event · runId · parentRunId', items: trail.map((e) => `${e.event} · ${short(e.runId)} · ${short(e.parentRunId)}`) });
    check({ name: 'root run has parentRunId=null', passed: Boolean(root) && root?.parentRunId === null, detail: `runId=${short(root?.runId)}` });
    const apiObserverStamped = provider !== ProviderType.JAI;
    check({ name: 'run-scoped events carry the run correlation', passed: Boolean(root && stepChild) && root?.parentRunId === null && stepChild?.parentRunId === root?.runId, detail: `run=${short(root?.runId)} step=${short(stepChild?.runId)} parent=${short(stepChild?.parentRunId)}` });
    check({
        name: apiObserverStamped ? 'api events are children of the step run' : 'JAI transport api events carry no runId (documented exception)',
        passed: Boolean(apiCall) && (apiObserverStamped ? apiCall?.runId === stepChild?.runId : apiCall?.runId == null),
        detail: `api=${short(apiCall?.runId)} step=${short(stepChild?.runId)}`,
    });
    const runScoped = trail.filter((e) => !e.event.startsWith('api_'));
    check({ name: 'every run-scoped tracked event carries a runId', passed: runScoped.length > 0 && runScoped.every((e) => typeof e.runId === 'string'), detail: `${trail.length} event(s); api stamped=${apiObserverStamped}` });
    if (!apiObserverStamped) log.condition({ label: 'correlation', branch: 'JAI transport exception', why: 'api_request/api_response are emitted by the JAI HTTP client without a run context; run/session events are stamped' });
    check({ name: 'the live run answered', passed: answer.trim().length > 0, detail: log.truncate({ text: answer.trim(), n: 80 }) });

    // ── 5 · a custom observer on a live session ──────────────────────────────
    log.section({ t: '5 · .withApiObserver: swap the telemetry sink' });
    const sessionBus = new EventEmitter();
    let reqs = 0;
    let resps = 0;
    /** @type {any} */
    let lastReq = null;
    sessionBus.on(EVENTS.CLIENT.API_REQUEST, (m) => { reqs += 1; lastReq = m; });
    sessionBus.on(EVENTS.CLIENT.API_RESPONSE, () => { resps += 1; });
    sessionBus.on('error', (err) => log.error({ m: '[observer] error', d: err?.message ?? err }));
    const observed = await client.session(defaultModel)
        .withSystemMessage('Answer in one word.')
        .withApiObserver({ observer: new EventEmitterApiObserver({ emitter: sessionBus }) })
        .run({ initialInput: 'Say hello.', options: { maxIterations: 2 } });
    check({ name: 'custom observer saw the request/response', passed: reqs >= 1 && resps >= 1, detail: `requests=${reqs} responses=${resps}` });
    check({ name: 'observer payloads keep runId correlation', passed: typeof lastReq?.runId === 'string' && lastReq.runId.length > 0, detail: `runId=${short(lastReq?.runId)}` });
    log.assistant({ m: observed.trim() });
    warnEmptyAnswer({ answer: observed, label: 'the observed run' });

    // ── 6 · unknown model → typed backend error ──────────────────────────────
    log.section({ t: '6 · unknown model → typed BackendError' });
    /** @type {Error|null} */
    let typedVendorErr = null;
    try {
        await client.session('model-that-does-not-exist-xyz').run({ initialInput: 'hi', options: { maxIterations: 1 } });
    } catch (err) { typedVendorErr = wrapError({ err, hints: { provider } }); }
    check({ name: 'unknown model surfaces as BackendError', passed: typedVendorErr instanceof BackendError, detail: typedVendorErr ? `${typedVendorErr.name} status=${/** @type {any} */ (typedVendorErr).status ?? '?'} — ${log.truncate({ text: typedVendorErr.message, n: 90 })}` : 'no error thrown' });

    // ── 7 · abort: the `aborted` event explains the stop ─────────────────────
    log.section({ t: '7 · abort: the `aborted` client event' });
    const ac = new AbortController();
    /** @type {string|null} */
    let abortReason = /** @type {string|null} */ (null);
    client.once(EVENTS.CLIENT.ABORTED, (/** @type {any} */ e) => { abortReason = e?.reason ?? ''; });
    /** @type {any} */
    let abortErr = null;
    try {
        await client.session(defaultModel).run({
            initialInput: 'Count from 1 to 200, one number per line.',
            options: { maxIterations: 3, signal: ac.signal, onEvent: (/** @type {any} */ e) => { if (!ac.signal.aborted && (e?.type === 'text' || e?.type === 'thought')) ac.abort(new Error('demo stop')); } },
        });
    } catch (err) { abortErr = err; }
    check({ name: 'the run surfaced an abort-shaped error', passed: isAbortError({ err: abortErr }), detail: `err=${abortErr?.name ?? 'none'}` });
    check({ name: 'the `aborted` event explained why', passed: typeof abortReason === 'string' && abortReason.length > 0, detail: `reason="${log.truncate({ text: String(abortReason ?? ''), n: 60 })}"` });

    reportUsage({ provider, usage });
    if (failures > 0) throw new Error(`${failures} check(s) failed`);
    log.success({ m: 'Observability surfaces verified.' });
}

runMain({ mainFn: main });
