// @ts-check
/**
 * Example 31 — The scheduler: work items, claims and the tick.
 *
 * A memory work source, a memory claim store, a manual clock that never fires
 * on its own, and a workflow that either completes or fails with a permission
 * error. Live, the completing item runs a real `createEngineRunner` turn; a
 * scripted permission failure stays deterministic in both modes.
 *
 *   A — start and the first tick   : `start()` runs one immediate tick; with a
 *       global cap of 1 the priority-1 item is dispatched and the other waits.
 *   B — a clean completion parks   : continuations are disabled, so the
 *       completion emits `completed` then `parked` and keeps the claim.
 *   C — a permission failure parks : `PERMISSION_DENIED` is non-retryable, so
 *       the attempt emits `failed` then `parked` and schedules no retry.
 *   D — the tracker moves          : the parked item turns terminal and its
 *       next check releases the claim (`reason: 'terminal'`).
 *   E — resetItem and stop         : `resetItem` releases the other item and
 *       `stop()` drains everything; no event carries a title or a message.
 *
 * Public API: `WorkScheduler`, `createMemoryWorkSource`,
 * `createMemoryClaimStore`, `createEngineRunner`, `EVENTS`, `log`.
 *
 * Run: `node test/examples/31_scheduler.mjs` (live) · `node test/examples/31_scheduler.mjs --offline` (deterministic)
 * Needs: `BACKEND` + provider credentials in `secret.env` for the live item;
 *        `--offline` needs none.
 *
 * @version 0.12.0
 */
import { EventEmitter } from 'node:events';
import { EVENTS, initializeClient, loadCredentials, log } from 'merci-sdk';
import {
    CLAIM_STATES, SCHEDULER_DEFAULTS, WorkScheduler, createEngineRunner, createMemoryClaimStore, createMemoryWorkSource,
} from 'merci-sdk/scheduler';
import { createAudit } from '../../examples/_shared/example-audit.mjs';
import { reportUsage, resolveExample, trackUsage, wireClient } from '../../examples/_shared/example-utils.mjs';

const OFFLINE = process.argv.includes('--offline');
const live = OFFLINE ? null : resolveExample();

const audit = createAudit({
    metaUrl: import.meta.url,
    id: 'audit/31_scheduler',
    offline: OFFLINE,
    provider: live?.provider ?? null,
    models: live ? live.toolModel : null,
    title: 'Example 31 — The scheduler',
});

/**
 * The live scheduler, so a thrown assertion still stops it instead of leaving
 * a poll timer and a claim behind.
 * @type {any}
 */
let activeScheduler = null;

// ── the manual clock ─────────────────────────────────────────────────────────
// Nothing fires on its own: `now` moves only when the example moves it, and the
// scheduler is driven by explicit `tick()` calls. `pollIntervalMs` is an hour,
// so the poll timer can never be the reason anything happens.
let now = 1_000_000;
let seq = 0;
/** @type {Map<number, { at: number, fn: () => void }>} */
const timers = new Map();
/** @type {{ now: () => number, setTimeout: (fn: () => void, ms: number) => number, clearTimeout: (id: unknown) => void }} */
const clock = {
    now: () => now,
    // The rest tuple keeps the scheduler's positional signature while staying a
    // single parameter (GUIDELINES R1); the library's own default clock does the same.
    setTimeout: (/** @type {[() => void, number]} */ ...args) => {
        const [fn, ms] = args;
        const id = ++seq;
        timers.set(id, { at: now + ms, fn });
        return id;
    },
    clearTimeout: (id) => { timers.delete(Number(id)); },
};

// ── the work source ──────────────────────────────────────────────────────────
// The array is captured by reference, so changing `state` here is what the next
// fetch sees — that is how a tracker moves in this demo.
const items = [
    {
        id: 'id-a',
        identifier: 'MER-29A',
        title: 'The scheduler demo item A',
        description: 'demo-only description text',
        state: 'Todo',
        dispatchable: true,
        priority: 1,
    },
    {
        id: 'id-b',
        identifier: 'MER-29B',
        title: 'The scheduler demo item B',
        description: 'demo-only description text',
        state: 'Todo',
        dispatchable: true,
        priority: 2,
    },
];

// ── the fake workflow ────────────────────────────────────────────────────────
// A's attempt is held on a gate so its running row is observable before the
// completion lands; B's attempt throws a permission error whose MESSAGE must
// never reach an event (only its name and code may).
/** @type {Map<string, () => void>} */
const gates = new Map();

/**
 * Hold one attempt until the example releases it.
 * @param {{identifier: string}} arg0 -
 * @returns {Promise<void>}
 */
const waitForGate = ({ identifier }) => new Promise((resolve) => {
    gates.set(identifier, () => resolve());
});

/**
 * @param {{identifier: string}} arg0 -
 * @returns {void}
 */
const releaseGate = ({ identifier }) => { gates.get(identifier)?.(); };

// Live plumbing: the real engine's summary and the completion signal the live
// scenario waits on. Offline leaves both untouched.
/** @type {string|null} */
let liveSummary = null;
/** @type {(() => void)|null} */
let resolveLiveA = null;
/** @type {Promise<void>|null} */
let liveADone = null;

/** @type {(arg0: {item: {identifier: string}}) => Promise<unknown>} */
const workflowRun = async ({ item }) => {
    if (item.identifier === 'MER-29A') {
        await waitForGate({ identifier: item.identifier });
        return { status: 'completed', usage: { total_tokens: 12, input_tokens: 8, output_tokens: 4 } };
    }
    throw Object.assign(new Error('permission denied for the demo'), { code: 'PERMISSION_DENIED' });
};

// ── the event capture ────────────────────────────────────────────────────────
/** @type {Array<{ name: string, envelope: Record<string, unknown> }>} */
const events = [];
const emitter = new EventEmitter();
// The scheduler's option type declares `on` as a zero-argument probe, so the sink
// exposes only the `emit` it calls; the real emitter receives every event below.
const eventSink = {
    emit: (/** @type {[string, Record<string, unknown>]} */ ...args) => {
        const [name, payload] = args;
        emitter.emit(name, payload);
    },
};
for (const name of [
    EVENTS.SCHEDULER.START, EVENTS.SCHEDULER.STOP, EVENTS.SCHEDULER.TICK,
    EVENTS.WORK_ITEM.CLAIMED, EVENTS.WORK_ITEM.DISPATCHED, EVENTS.WORK_ITEM.COMPLETED,
    EVENTS.WORK_ITEM.FAILED, EVENTS.WORK_ITEM.PARKED, EVENTS.WORK_ITEM.RELEASED,
]) {
    emitter.on(name, (/** @type {Record<string, unknown>} */ envelope) => { events.push({ name, envelope }); });
}

/** @type {(name: string) => number} */
const countOf = (name) => events.filter((entry) => entry.name === name).length;
/** @type {(name: string) => Array<Record<string, unknown>>} */
const payloadsOf = (name) => events.filter((entry) => entry.name === name).map((entry) => entry.envelope);
/** @type {(name: string) => Record<string, unknown>|null} */
const firstPayload = (name) => payloadsOf(name)[0] ?? null;
/** @type {(identifier: string) => Array<{ name: string, envelope: Record<string, unknown> }>} */
const eventsFor = (identifier) => events.filter((entry) => entry.envelope.identifier === identifier);

/**
 * The first running row, or an empty record when nothing is running.
 * @param {ReturnType<WorkScheduler['snapshot']>} snapshot -
 * @returns {Record<string, unknown>}
 */
const firstRunning = (snapshot) => snapshot.running[0] ?? {};

/**
 * Let the scheduler's promise chains settle. No fake-clock time passes.
 * @returns {Promise<void>}
 */
const flush = async () => {
    for (let round = 0; round < 5; round += 1) {
        await new Promise((resolve) => { setImmediate(resolve); });
    }
};

/**
 * The event names of one item, in emission order, as one comparable string.
 * @param {string} identifier -
 * @returns {string}
 */
const sequenceOf = (identifier) => eventsFor(identifier).map((entry) => entry.name).join(' → ');

async function main() {
    log.option({ name: 'work source', value: `${items.length} items (memory)`, source: 'createMemoryWorkSource — captured by reference' });
    log.option({ name: 'clock', value: `${now} ms (manual)`, source: 'a manual clock — no timer ever fires' });

    /** @type {Awaited<ReturnType<typeof initializeClient>>['client']|null} */
    let client = null;
    /** @type {ReturnType<typeof trackUsage>|null} */
    let usage = null;
    let apiCalls = 0;
    /** @type {ReturnType<typeof createEngineRunner>|null} */
    let engineWorkflow = null;
    if (live !== null) {
        const initialized = await initializeClient({
            provider: live.provider,
            options: loadCredentials({ provider: live.provider }),
        });
        client = initialized.client;
        wireClient({ client });
        usage = trackUsage({ client });
        client.on('api_request', () => { apiCalls += 1; });
        liveADone = new Promise((resolve) => { resolveLiveA = () => resolve(undefined); });
        engineWorkflow = createEngineRunner({
            engine: 'agentic',
            client,
            model: live.toolModel,
            prompt: /** @type {(arg0: { item: { identifier: string } }) => string} */ (({ item }) => `Reply with exactly: SCHEDULER-LIVE-${item.identifier}`),
        });
    }

    // The split: MER-29A runs the real engine live and the scripted gate
    // offline; MER-29B's permission failure is scripted in both modes.
    const workflow = {
        /** @param {Parameters<ReturnType<typeof createEngineRunner>['run']>[0]} args */
        async run(args) {
            if (args.item.identifier !== 'MER-29A' || engineWorkflow === null) {
                return workflowRun(args);
            }
            try {
                const result = await engineWorkflow.run(args);
                liveSummary = result.summary ?? null;
                return result;
            } finally {
                resolveLiveA?.();
            }
        },
    };

    const scheduler = new WorkScheduler({
        workSource: createMemoryWorkSource({ items }),
        workflow,
        claims: createMemoryClaimStore(),
        clock,
        eventEmitter: eventSink,
        activeStates: ['Todo'],
        terminalStates: ['Done'],
        concurrency: { global: 1 },
        retry: { baseMs: 1_000, maxMs: 1_000 },
        continuation: { delayMs: 0, max: 0 },
        stallTimeoutMs: 0,
        pollIntervalMs: 3_600_000,
    });
    activeScheduler = scheduler;

    // ── A: start and the first tick ──────────────────────────────────────────
    audit.scenario({
        id: 'A', title: 'start and the first tick',
        goal: 'start() runs one immediate tick, and a global cap of 1 dispatches only the priority-1 item',
        expect: '1 scheduler:start · 1 scheduler:tick fetched=2 dispatched=1 · MER-29A claimed then dispatched · MER-29B untouched · the running row is id-a / MER-29A / work:MER-29A / workspacePath null',
        fails: [
            { code: 'no-first-tick', symptom: 'start() emitted no scheduler:tick', hint: 'start() runs one immediate tick before it arms the poll loop' },
            { code: 'over-dispatch', symptom: 'MER-29B was dispatched too', hint: 'concurrency.global 1 plus a synchronous slot reservation stops the second item' },
            { code: 'wrong-order', symptom: 'MER-29B was dispatched before MER-29A', hint: 'priority 1 sorts before priority 2' },
        ],
        input: { items: ['MER-29A', 'MER-29B'], concurrency: { global: 1 }, pollIntervalMs: 3_600_000 },
    });

    await scheduler.start();

    const tickA = firstPayload(EVENTS.SCHEDULER.TICK);
    const claimedA = firstPayload(EVENTS.WORK_ITEM.CLAIMED);
    const dispatchedA = firstPayload(EVENTS.WORK_ITEM.DISPATCHED);
    const rowA = firstRunning(scheduler.snapshot());
    audit.observe({ name: 'first tick', value: tickA });
    audit.observe({ name: 'running row', value: rowA });
    audit.check({
        name: 'start() emits exactly one scheduler:start',
        ok: countOf(EVENTS.SCHEDULER.START) === 1,
        detail: { expected: '1 scheduler:start', observed: `${countOf(EVENTS.SCHEDULER.START)} scheduler:start` },
    });
    audit.check({
        name: 'the immediate tick fetched both items and dispatched only one',
        ok: countOf(EVENTS.SCHEDULER.TICK) === 1
            && tickA?.outcome === 'ok' && tickA?.fetched === 2 && tickA?.dispatched === 1,
        detail: {
            expected: '1 tick · outcome ok · fetched 2 · dispatched 1',
            observed: `${countOf(EVENTS.SCHEDULER.TICK)} tick · ${String(tickA?.outcome)} · fetched ${String(tickA?.fetched)} · dispatched ${String(tickA?.dispatched)}`,
        },
    });
    audit.check({
        name: 'only MER-29A was claimed and dispatched',
        ok: countOf(EVENTS.WORK_ITEM.CLAIMED) === 1 && claimedA?.identifier === 'MER-29A'
            && countOf(EVENTS.WORK_ITEM.DISPATCHED) === 1 && dispatchedA?.identifier === 'MER-29A',
        detail: {
            expected: '1 claimed and 1 dispatched, both MER-29A',
            observed: `claimed ${countOf(EVENTS.WORK_ITEM.CLAIMED)} (${String(claimedA?.identifier)}) · dispatched ${countOf(EVENTS.WORK_ITEM.DISPATCHED)} (${String(dispatchedA?.identifier)})`,
        },
    });
    audit.check({
        name: 'the running row names the item, its thread and a null workspace path',
        ok: rowA.workItemId === 'id-a' && rowA.identifier === 'MER-29A'
            && rowA.threadId === 'work:MER-29A' && rowA.workspacePath === null,
        detail: {
            expected: 'id-a · MER-29A · work:MER-29A · null',
            observed: `${String(rowA.workItemId)} · ${String(rowA.identifier)} · ${String(rowA.threadId)} · ${String(rowA.workspacePath)}`,
        },
    });
    // The vocabulary and the defaults are public so a host can read the same
    // contract the scheduler applies instead of hard-coding the numbers.
    const states = Object.values(CLAIM_STATES);
    audit.observe({ name: 'claim states', value: states });
    audit.observe({ name: 'defaults', value: { pollIntervalMs: SCHEDULER_DEFAULTS.pollIntervalMs, global: SCHEDULER_DEFAULTS.concurrency.global } });
    audit.check({
        name: 'the claim vocabulary is published and the example overrides the defaults',
        ok: states.join(',') === 'unclaimed,claimed,running,retry_queued,parked,released'
            && SCHEDULER_DEFAULTS.pollIntervalMs === 30_000
            && scheduler.snapshot().pollIntervalMs !== SCHEDULER_DEFAULTS.pollIntervalMs,
        detail: {
            expected: 'six claim states · default poll 30000 · this run differs',
            observed: `${states.join(',')} · default ${SCHEDULER_DEFAULTS.pollIntervalMs} · run ${scheduler.snapshot().pollIntervalMs}`,
        },
    });
    audit.end();

    // ── B: a clean completion parks the item ─────────────────────────────────
    audit.scenario({
        id: 'B', title: 'a clean completion parks the item',
        goal: 'with continuations disabled, a completed attempt parks and keeps its claim instead of releasing it',
        expect: 'MER-29A emits completed then parked (reason continuations_disabled) · the claim is kept · dispatches 1, attempts 1, totalTokens 12 · no released event',
        fails: [
            { code: 'released', symptom: 'the completion released the claim', hint: 'continuation.max 0 parks the item; a park keeps the claim so the counters cannot reset' },
            { code: 'no-usage', symptom: 'totals.totalTokens is not 12', hint: 'accumulateUsage folds the run result usage into the totals' },
            { code: 'stuck-running', symptom: 'the item is still running', hint: 'the gate is released before flush()' },
        ],
        input: { continuation: { delayMs: 0, max: 0 }, usage: { total_tokens: 12 } },
    });

    // A completion with continuations disabled parks the item, and a park keeps
    // the claim: the counters cannot reset into an unbounded re-dispatch loop.
    // Offline releases the scripted gate; live waits for the real engine run.
    if (OFFLINE) releaseGate({ identifier: 'MER-29A' });
    else if (liveADone !== null) await liveADone;
    await flush();

    const snapshotB = scheduler.snapshot();
    const totalsB = snapshotB.totals;
    const parkedB = payloadsOf(EVENTS.WORK_ITEM.PARKED).find((payload) => payload.identifier === 'MER-29A') ?? null;
    audit.observe({ name: 'MER-29A events', value: sequenceOf('MER-29A') });
    audit.observe({ name: 'totals after the completion', value: { dispatches: totalsB.dispatches, attempts: totalsB.attempts, totalTokens: totalsB.totalTokens } });
    audit.check({
        name: 'MER-29A emits completed, then parked',
        ok: sequenceOf('MER-29A') === [
            EVENTS.WORK_ITEM.CLAIMED, EVENTS.WORK_ITEM.DISPATCHED,
            EVENTS.WORK_ITEM.COMPLETED, EVENTS.WORK_ITEM.PARKED,
        ].join(' → '),
        detail: {
            expected: 'claimed → dispatched → completed → parked',
            observed: sequenceOf('MER-29A'),
        },
    });
    audit.check({
        name: 'the park reason is continuations_disabled and the claim is kept',
        ok: parkedB?.reason === 'continuations_disabled'
            && snapshotB.claimed.includes('MER-29A'),
        detail: {
            expected: 'reason continuations_disabled · claimed contains MER-29A',
            observed: `reason ${String(parkedB?.reason)} · claimed ${snapshotB.claimed.join(',')}`,
        },
    });
    audit.check({
        name: 'the completion is counted once with its reported tokens',
        // JAI reports credits, not tokens: only the offline scripted usage fixes a token total.
        ok: totalsB.dispatches === 1 && totalsB.attempts === 1
            && (OFFLINE ? totalsB.totalTokens === 12 : true),
        detail: {
            expected: OFFLINE ? 'dispatches 1 · attempts 1 · totalTokens 12' : 'dispatches 1 · attempts 1',
            observed: `dispatches ${totalsB.dispatches} · attempts ${totalsB.attempts} · totalTokens ${totalsB.totalTokens}`,
        },
    });
    audit.check({
        name: 'a park does not release the claim',
        ok: eventsFor('MER-29A').every((entry) => entry.name !== EVENTS.WORK_ITEM.RELEASED),
        detail: { expected: 'no work_item:released', observed: sequenceOf('MER-29A') },
    });
    if (live !== null) {
        audit.check({
            name: 'the live engine completed MER-29A with its prompt marker',
            ok: apiCalls > 0 && liveSummary !== null && liveSummary.includes('SCHEDULER-LIVE-MER-29A')
                && countOf(EVENTS.WORK_ITEM.COMPLETED) === 1,
            detail: {
                expected: '> 0 api_request · the summary contains SCHEDULER-LIVE-MER-29A · 1 completed',
                observed: `${apiCalls} api_request · summary ${JSON.stringify(liveSummary)} · ${countOf(EVENTS.WORK_ITEM.COMPLETED)} completed`,
            },
        });
        audit.check({
            name: 'the live completion is counted and the snapshot recorded the dispatch',
            ok: totalsB.dispatches >= 1 && totalsB.attempts >= 1,
            detail: {
                expected: 'dispatches >= 1 · attempts >= 1',
                observed: `dispatches ${totalsB.dispatches} · attempts ${totalsB.attempts}`,
            },
        });
    }
    audit.end();

    // ── C: a permission failure parks non-retryably ──────────────────────────
    audit.scenario({
        id: 'C', title: 'a permission failure parks non-retryably',
        goal: 'a PERMISSION_DENIED run is a permission_block failure, so it parks on the first attempt with no retry',
        expect: 'scheduler.tick() dispatches MER-29B · failed (permission_block) then parked (non_retryable) · the claim is kept · failures 1, dispatches 2 · no released event',
        fails: [
            { code: 'retried', symptom: 'work_item:retry_scheduled fired for MER-29B', hint: 'permission_block is in the non-retryable set; it parks instead of consuming the retry budget' },
            { code: 'wrong-class', symptom: 'failureClass is not permission_block', hint: 'failureEvidence maps errorCode PERMISSION_DENIED to permissionBlocked' },
            { code: 'claim-dropped', symptom: 'MER-29B is not in snapshot().claimed', hint: 'a park keeps the claim until a terminal, inactive, missing or reset release' },
        ],
        input: { errorCode: 'PERMISSION_DENIED', concurrency: { global: 1 } },
    });

    await scheduler.tick();
    await flush();

    const snapshotC = scheduler.snapshot();
    const totalsC = snapshotC.totals;
    const failedC = payloadsOf(EVENTS.WORK_ITEM.FAILED).find((payload) => payload.identifier === 'MER-29B') ?? null;
    const parkedC = payloadsOf(EVENTS.WORK_ITEM.PARKED).find((payload) => payload.identifier === 'MER-29B') ?? null;
    audit.observe({ name: 'MER-29B events', value: sequenceOf('MER-29B') });
    audit.observe({ name: 'failure', value: { failureClass: failedC?.failureClass, errorName: failedC?.errorName, errorCode: failedC?.errorCode } });
    audit.check({
        name: 'MER-29B emits failed, then parked',
        ok: sequenceOf('MER-29B') === [
            EVENTS.WORK_ITEM.CLAIMED, EVENTS.WORK_ITEM.DISPATCHED,
            EVENTS.WORK_ITEM.FAILED, EVENTS.WORK_ITEM.PARKED,
        ].join(' → '),
        detail: {
            expected: 'claimed → dispatched → failed → parked',
            observed: sequenceOf('MER-29B'),
        },
    });
    audit.check({
        name: 'the failure is a permission_block parked as non_retryable',
        ok: failedC?.failureClass === 'permission_block' && parkedC?.reason === 'non_retryable',
        detail: {
            expected: 'failureClass permission_block · reason non_retryable',
            observed: `failureClass ${String(failedC?.failureClass)} · reason ${String(parkedC?.reason)}`,
        },
    });
    audit.check({
        name: 'the failed attempt is counted and the claim is kept',
        ok: totalsC.failures === 1 && totalsC.dispatches === 2
            && snapshotC.claimed.includes('MER-29B'),
        detail: {
            expected: 'failures 1 · dispatches 2 · claimed contains MER-29B',
            observed: `failures ${totalsC.failures} · dispatches ${totalsC.dispatches} · claimed ${snapshotC.claimed.join(',')}`,
        },
    });
    audit.check({
        name: 'neither item has been released yet',
        ok: countOf(EVENTS.WORK_ITEM.RELEASED) === 0,
        detail: { expected: '0 released', observed: `${countOf(EVENTS.WORK_ITEM.RELEASED)} released` },
    });
    audit.end();

    // ── D: the tracker moves ─────────────────────────────────────────────────
    audit.scenario({
        id: 'D', title: 'the tracker moves: a terminal parked item is released',
        goal: 'a parked item is re-checked on a tick; once it is terminal its claim is released',
        expect: 'MER-29A moves to Done in the source · 1000 ms (the parked backoff) · one scheduler.tick() · released MER-29A reason terminal · A gone from parked and claimed',
        fails: [
            { code: 'no-release', symptom: 'the terminal item stayed parked', hint: 'the parked re-check runs at the start of every tick, once nextCheckAt is due' },
            { code: 'too-early', symptom: 'the release fired before the clock advanced', hint: 'nextCheckAt is now + min(retry.maxMs * 2^checks, 6h) — 1000 ms at the first check' },
            { code: 're-dispatched', symptom: 'MER-29A was dispatched again', hint: 'a terminal item is not active and fails the eligibility matrix' },
        ],
        input: { identifier: 'MER-29A', state: 'Done', advanceMs: 1_000 },
    });

    // The parked item is re-checked on the next due tick: terminal releases the
    // claim, it never re-dispatches.
    items[0].state = 'Done';
    now += 1_000;
    await scheduler.tick();

    const releasedD = payloadsOf(EVENTS.WORK_ITEM.RELEASED).find((payload) => payload.identifier === 'MER-29A') ?? null;
    const snapshotD = scheduler.snapshot();
    audit.observe({ name: 'release', value: releasedD });
    audit.observe({ name: 'parked after the check', value: snapshotD.parked.map((row) => `${String(row.identifier)}:${String(row.reason)}`) });
    audit.check({
        name: 'the terminal parked item is released with reason terminal',
        ok: releasedD?.reason === 'terminal',
        detail: { expected: 'released MER-29A · reason terminal', observed: `released ${String(releasedD?.identifier)} · reason ${String(releasedD?.reason)}` },
    });
    audit.check({
        name: 'A is gone from the parked and claimed views',
        ok: !snapshotD.parked.some((row) => row.identifier === 'MER-29A')
            && !snapshotD.claimed.includes('MER-29A'),
        detail: {
            expected: 'no MER-29A in parked or claimed',
            observed: `parked ${snapshotD.parked.map((row) => String(row.identifier)).join(',')} · claimed ${snapshotD.claimed.join(',')}`,
        },
    });
    if (live !== null) {
        audit.check({
            name: 'the live run released its claim when the tracker moved to Done',
            ok: releasedD?.reason === 'terminal' && !snapshotD.claimed.includes('MER-29A'),
            detail: {
                expected: 'released MER-29A · reason terminal · no claim',
                observed: `released ${String(releasedD?.identifier)} · reason ${String(releasedD?.reason)} · claimed ${snapshotD.claimed.join(',')}`,
            },
        });
    }
    audit.end();

    // ── E: resetItem and stop ────────────────────────────────────────────────
    audit.scenario({
        id: 'E', title: 'resetItem and stop',
        goal: 'resetItem releases a parked item so the host can retry it, and stop drains the loop and clears every timer',
        expect: 'resetItem(MER-29B) → released reason reset · stop({reason}) → {drained:true, running:0, retrying:0, parked:0} · one scheduler:stop · snapshot started+stopped with no claims · 0 armed timers · no event carries a title, a description or the error message',
        fails: [
            { code: 'not-reset', symptom: 'MER-29B was not released with reason reset', hint: 'resetItem clears counters, parking and the claim so the next fetch can re-claim' },
            { code: 'bad-counts', symptom: 'stop() reported a non-zero count', hint: 'resetItem already removed the parked row; nothing is queued to abandon' },
            { code: 'timer-leak', symptom: 'stop() left the poll timer armed', hint: 'stop() must clear the timer so a library never keeps the host process alive' },
            { code: 'leak', symptom: 'an event carried a title, a description or the error message', hint: 'event payloads carry identifiers and codes only — never item text or err.message' },
        ],
        input: { reset: 'MER-29B', stop: { reason: 'example-done' } },
    });

    // resetItem clears the parked row and releases the claim, so the host can
    // retry the item after fixing it.
    await scheduler.resetItem({ identifier: 'MER-29B' });
    const resetE = payloadsOf(EVENTS.WORK_ITEM.RELEASED).find((payload) => payload.identifier === 'MER-29B') ?? null;

    // The poll timer is armed by the last tick, so the post-stop zero below is
    // a real clear and not a scheduler that never armed one.
    const armedBeforeStop = timers.size;
    const counts = await scheduler.stop({ reason: 'example-done' });
    activeScheduler = null;
    const snapshotE = scheduler.snapshot();
    const stopE = firstPayload(EVENTS.SCHEDULER.STOP);

    // The hygiene proof: serialize every captured envelope and look for text
    // that must never leave the runner (item prose, or an error message).
    const serialized = events.map((entry) => JSON.stringify(entry.envelope)).join('\n');
    const forbidden = [
        '"title"', '"description"', 'The scheduler demo item A', 'The scheduler demo item B',
        'demo-only description text', 'permission denied for the demo',
    ];
    const leaked = forbidden.filter((needle) => serialized.includes(needle));

    audit.observe({ name: 'stop counts', value: counts });
    audit.observe({ name: 'released events', value: payloadsOf(EVENTS.WORK_ITEM.RELEASED).map((payload) => `${String(payload.identifier)}:${String(payload.reason)}`) });
    audit.check({
        name: 'resetItem releases MER-29B with reason reset',
        ok: resetE?.reason === 'reset',
        detail: { expected: 'released MER-29B · reason reset', observed: `released ${String(resetE?.identifier)} · reason ${String(resetE?.reason)}` },
    });
    audit.check({
        name: 'stop reports a clean drain and emits one scheduler:stop',
        ok: JSON.stringify(counts) === JSON.stringify({ drained: true, running: 0, retrying: 0, parked: 0 })
            && countOf(EVENTS.SCHEDULER.STOP) === 1 && stopE?.reason === 'example-done',
        detail: {
            expected: '{"drained":true,"running":0,"retrying":0,"parked":0} · 1 stop · reason example-done',
            observed: `${JSON.stringify(counts)} · ${countOf(EVENTS.SCHEDULER.STOP)} stop · reason ${String(stopE?.reason)}`,
        },
    });
    audit.check({
        name: 'the snapshot is started and stopped with no claimed ids',
        ok: snapshotE.started === true && snapshotE.stopped === true && snapshotE.claimed.length === 0,
        detail: {
            expected: 'started true · stopped true · claimed []',
            observed: `started ${snapshotE.started} · stopped ${snapshotE.stopped} · claimed [${snapshotE.claimed.join(',')}]`,
        },
    });
    audit.observe({ name: 'armed timers before stop', value: armedBeforeStop });
    audit.check({
        name: 'the poll timer was armed before stop, and stop cleared it',
        ok: armedBeforeStop >= 1 && timers.size === 0,
        detail: { expected: '0 armed timers', observed: `${timers.size} armed timers` },
    });
    audit.check({
        name: 'no captured event carries a title, a description or the error message',
        ok: leaked.length === 0,
        detail: {
            expected: 'none of: title, description, the item titles, the error message',
            observed: leaked.length === 0 ? `${events.length} envelopes clean` : `leaked: ${leaked.join(', ')}`,
        },
    });
    audit.end();

    if (live !== null && usage !== null) reportUsage({ provider: live.provider, usage });
    log.success({ m: 'Scheduler verified: dispatch, a completion park, a permission park, terminal release, reset and stop.' });
}

// The await matters: without it the run is not a top-level await, and a
// stalled round would exit 0 with a truncated log instead of failing.
try {
    await audit.run(main);
} finally {
    // A failed assertion before scenario E must still stop the scheduler.
    if (activeScheduler !== null) {
        await activeScheduler.stop({ reason: 'example-error' }).catch(() => {});
    }
}
