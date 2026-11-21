// @ts-check
/**
 * Example 08 — Resilience: retries, fan-out limits, breaker, live policy wiring.
 *
 * Sections A–C are DETERMINISTIC and run BEFORE any client is built (no backend,
 * no network, no stdin). Section LIVE then applies the same policies to a real
 * session.
 *
 *   A — retry       : `ExponentialBackoffPolicy` drives a flaky operation; the
 *                     number of attempts is asserted (2 failures → success).
 *   B — fan-out     : `createLimiter` caps concurrency; `runBatch` returns
 *                     index-aligned settled outcomes where one rejection never
 *                     cancels its siblings.
 *   C — breaker     : `CircuitBreaker` + `runGuardedStep`: once open, calls fail
 *                     fast with `BREAKER_OPEN_CODE` instead of touching the op.
 *   LIVE            : `.withRetryPolicy`, `.withStreamTimeout` (sliding-window
 *                     `InactivityTimeoutPolicy`), `.withBudget`, and a
 *                     `parameter_warning` listener on a real run.
 *
 * Public API: `ExponentialBackoffPolicy`, `createLimiter`, `runBatch`,
 * `CircuitBreaker`, `runGuardedStep`, `BREAKER_OPEN_CODE`, `InactivityTimeoutPolicy`,
 * `EVENTS`, `defaultDisplay`.
 *
 * Run: `node examples/08_resilience.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env` (only for the LIVE tail).
 *
 * @version 0.23.0
 */
import {
    BREAKER_OPEN_CODE, CircuitBreaker, EVENTS, ExponentialBackoffPolicy, InactivityTimeoutPolicy,
    createLimiter, defaultDisplay, initializeClient, loadCredentials, log, runBatch, runGuardedStep,
} from 'merci-sdk';
import { resolveExample, reportUsage, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
/** @param {{name: string, passed: boolean, detail?: string}} arg0 */
function check({ name, passed, detail }) {
    if (!passed) failures += 1;
    log.check({ name, passed, detail });
}

async function main() {
    log.header({ t: 'Example 08 — Resilience (deterministic core + live tail)' });

    // ══ OFFLINE: sections A–C never construct a client ══════════════════════

    // ── A · retry with exponential backoff ───────────────────────────────────
    log.section({ t: 'A · ExponentialBackoffPolicy on a flaky operation' });
    const policy = new ExponentialBackoffPolicy({ maxRetries: 2, initialDelayMs: 1, maxDelayMs: 4, jitterMs: 0 });
    log.option({ name: 'policy', value: 'maxRetries=2 initialDelayMs=1 maxDelayMs=4 jitterMs=0', source: 'tiny deterministic delays for the demo' });

    let attempts = 0;
    const flaky = async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('connection reset by peer'), { code: 'ECONNRESET' });
        return 'recovered';
    };
    const [flakyOutcome] = await runBatch({ items: ['op-1'], worker: flaky, retryPolicy: policy });
    check({ name: 'two transient failures retried into success', passed: flakyOutcome.status === 'fulfilled' && flakyOutcome.value === 'recovered' && attempts === 3, detail: `attempts=${attempts} status=${flakyOutcome.status}` });

    let hardAttempts = 0;
    const down = async () => { hardAttempts += 1; throw Object.assign(new Error('connection reset by peer'), { code: 'ECONNRESET' }); };
    const [hardOutcome] = await runBatch({ items: ['op-2'], worker: down, retryPolicy: policy });
    check({ name: 'the policy cap stops a permanently down op', passed: hardOutcome.status === 'rejected' && hardAttempts === policy.maxRetries + 1, detail: `attempts=${hardAttempts} (1 + ${policy.maxRetries} retries)` });

    // ── B · limiter + batch outcomes ─────────────────────────────────────────
    log.section({ t: 'B · createLimiter + runBatch: bounded fan-out' });
    const limiter = createLimiter({ maxConcurrent: 2 });
    let inFlight = 0;
    let peak = 0;
    /** @type {number[]} */
    const completionOrder = [];
    const limited = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => limiter.run(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight -= 1;
        completionOrder.push(n);
        return n * 2;
    })));
    log.event({ type: 'limiter completion order', payload: completionOrder });
    check({ name: 'createLimiter never exceeded maxConcurrent=2', passed: peak === 2, detail: `peak observed=${peak}` });
    check({ name: 'Promise.all keeps input order', passed: limited.join(',') === '2,4,6,8,10,12', detail: `[${limited.join(', ')}]` });

    let batchInFlight = 0;
    let batchPeak = 0;
    const batch = await runBatch({
        items: [1, 2, 3, 4, 5, 6],
        maxConcurrent: 2,
        worker: async (n) => {
            batchInFlight += 1;
            batchPeak = Math.max(batchPeak, batchInFlight);
            await sleep(5);
            batchInFlight -= 1;
            if (n === 3) throw new Error('item 3 is poison');
            return n * 2;
        },
    });
    const fulfilled = batch.filter((r) => r.status === 'fulfilled');
    check({ name: 'one rejection does not cancel its siblings', passed: batch.length === 6 && fulfilled.length === 5 && batch[2].status === 'rejected', detail: `fulfilled=${fulfilled.length} rejected=${batch.length - fulfilled.length}` });
    check({ name: 'settled outcomes stay index-aligned', passed: batch.every((r, i) => (r.status === 'fulfilled' ? r.value === (i + 1) * 2 : i === 2)), detail: `[${batch.map((r) => (r.status === 'fulfilled' ? r.value : '×')).join(', ')}]` });
    check({ name: 'runBatch honored maxConcurrent=2', passed: batchPeak === 2, detail: `peak observed=${batchPeak}` });

    // ── C · circuit breaker ──────────────────────────────────────────────────
    log.section({ t: 'C · CircuitBreaker + runGuardedStep: open = fail fast' });
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 40 });
    let backendCalls = 0;
    // The breaker counts provider failures only: a 4xx (a caller bug) must not
    // trip it. So the demo's outage is a real transient failure — a reset
    // connection — not a plain Error.
    const failingStep = async () => { backendCalls += 1; throw Object.assign(new Error('backend is down'), { code: 'ECONNRESET' }); };
    const onBreakerOpen = () => {
        const err = Object.assign(new Error('circuit breaker open — not calling the backend'), { code: BREAKER_OPEN_CODE, nonRetryable: true });
        throw err;
    };
    const guarded = () => runGuardedStep({ breaker, run: failingStep, onBreakerOpen, onFailure: ({ err }) => /** @type {Error} */ (err) });
    const first = await guarded();
    const second = await guarded();
    check({ name: 'failures open the breaker at the threshold', passed: breaker.isOpen && first.message === 'backend is down' && second.message === 'backend is down' && backendCalls === 2, detail: `isOpen=${breaker.isOpen} op calls=${backendCalls}` });

    /** @type {any} */
    let openErr = null;
    try { await guarded(); } catch (err) { openErr = err; }
    check({ name: 'an open breaker fails fast with BREAKER_OPEN_CODE', passed: openErr?.code === BREAKER_OPEN_CODE && backendCalls === 2, detail: `code=${openErr?.code} op calls stayed at ${backendCalls}` });
    await sleep(60);
    check({ name: 'after the cooldown the breaker half-opens', passed: breaker.canRun(), detail: `cooldownMs=${breaker.cooldownMs}` });

    // ══ LIVE: the same policies wrapped around a real session ═══════════════
    log.section({ t: 'LIVE · retry + stream timeout + budget + parameter_warning' });
    const { provider, defaultModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    /** @type {any[]} */
    const parameterWarnings = [];
    client.on(EVENTS.CLIENT.PARAMETER_WARNING, (/** @type {any} */ e) => {
        parameterWarnings.push(e);
        log.warn({ m: `parameter_warning: '${e.parameter}' ignored on ${e.provider} (model ${e.model}) — ${e.message}` });
    });
    let retries = 0;
    client.on(EVENTS.CLIENT.API_RETRY, () => { retries += 1; });

    const livePolicy = new ExponentialBackoffPolicy({ maxRetries: 2, initialDelayMs: 500, maxDelayMs: 4_000 });
    const liveSession = client.session(defaultModel)
        .withSystemMessage('You are a concise assistant.')
        .withRetryPolicy({ policy: livePolicy })
        .withStreamTimeout({ policy: new InactivityTimeoutPolicy({ timeoutMs: 60_000, firstChunkMs: 30_000 }) })
        .withBudget({ budget: { maxTotalTokens: 50_000 } })
        .withParameters({ params: (/** @type {any} */ b) => b.temperature(0.2).topK({ v: 40 }).stream(true) });

    const livePrompt = 'Say hello in one sentence.';
    log.user({ m: livePrompt });
    const answer = await liveSession.run({ initialInput: livePrompt, options: { maxIterations: 3, onEvent: defaultDisplay().onEvent } });
    warnEmptyAnswer({ answer, label: 'the resilient session' });
    check({ name: 'the fully-wrapped session answered', passed: answer.trim().length > 0, detail: log.truncate({ text: answer.trim(), n: 80 }) });
    log.event({ type: 'live run summary', payload: { retries, parameterWarnings: parameterWarnings.length }, detail: 'a healthy run needs no retry; this backend/model filtered 0..n parameters' });

    reportUsage({ provider, usage });
    if (failures > 0) throw new Error(`${failures} check(s) failed`);
    log.success({ m: 'Resilience primitives and live policy wiring verified.' });
}

runMain({ mainFn: main });
