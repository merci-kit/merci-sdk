// @ts-check
/**
 * Example 30 — An unattended queue that retries, parks and resumes.
 *
 * Nobody is watching this board: a scheduler polls it, claims one item at a
 * time, and remembers what failed. One story, four parts:
 *
 *   A — one board, three sources : memory (`createMemoryWorkSource`), a JSON
 *       directory (`createJsonFileWorkSource`) and a host function
 *       (`createFunctionWorkSource`). Each adapter normalizes what it reads and
 *       skips a row it cannot use; `normalizeWorkItem` freezes a strict record,
 *       `sortForDispatch` orders the merge, and the memory and file claim stores
 *       grant one owner per item.
 *   B — one heartbeat : `start()` runs one immediate tick on a manual clock. The
 *       live item answers a marker through `createEngineRunner`; a `rate_limit`
 *       failure retries after its backoff and completes; a `PERMISSION_DENIED`
 *       failure parks on the first attempt; a promoted item meets
 *       `limits.maxDispatches` and the budget stops it.
 *   C — a restart : `createFileAttemptStore` is the only state that outlives the
 *       process. A fresh scheduler hydrates the failure count, gets one more
 *       dispatch and parks as `attempts_exhausted`; that dispatch reports attempt
 *       1 again, because the persisted number is a failure count, not an ordinal.
 *       `resetItem` clears the record so the item runs from a clean budget.
 *   D — four engines : one attempt, four engines — agentic, dag (`planFor`),
 *       stateMachine (`graphFor`), discussion (`agents`) — and a DAG checkpoint
 *       that resumes with no model call and no usage.
 *
 * What this shows:
 *   - the board is a read-only source; the scheduler never writes it
 *   - retry vs park is decided by the failure class, not by a counter
 *   - the attempt store carries the budget and the park, never the queue
 *   - one runner result is this attempt's spend, not a running total
 *
 * Run: `node examples/30_scheduler.mjs`
 * Needs: provider credentials in `secret.env` (`PROVIDER=google_genai`).
 *
 * @version 0.23.0
 */
import { EventEmitter } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    EVENTS, LocalFileSessionStore, RunContext, WorkSourceError, initializeClient, loadCredentials, log,
} from 'merci-sdk';
import {
    CLAIM_STATES, SCHEDULER_DEFAULTS, WorkScheduler, createEngineRunner, createFileAttemptStore,
    createFileClaimStore, createFunctionWorkSource, createJsonFileWorkSource, createMemoryClaimStore,
    createMemoryWorkSource, normalizeWorkItem, sortForDispatch,
} from 'merci-sdk/scheduler';
import { SCRATCH_DIR } from './_shared/real-tools.mjs';
import { reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

const STATE_DIR = join(SCRATCH_DIR, '30-scheduler');
const MARKER = 'QUEUE-30';
const LIVE_PROMPT = `Reply with exactly ${MARKER}-LIVE and nothing else.`;
const TASK = 'Name one condition that must hold before shipping on Friday. At most 12 words.';

/** @param {{id?: string, identifier?: string, state?: string, priority?: number|null, createdAt?: number|null}} [arg0] */
const rawItem = ({ id = 'id-1', identifier = 'MER-1', state = 'Todo', priority = null, createdAt = null } = {}) => ({
    id, identifier, title: `Work ${identifier}`, state, dispatchable: true, priority, createdAt,
});

// ── the manual clock ─────────────────────────────────────────────────────────
// A retry is due at `now + baseMs`; the example advances the clock, never time.
let now = 1_000_000;
let timerSeq = 0;
/** @type {Map<number, {at: number, fn: () => void}>} */
const timers = new Map();
const createClock = () => ({
    now: () => now,
    /** @param {[() => void, number]} args */
    setTimeout: (...args) => {
        const [fn, ms] = args;
        timers.set(++timerSeq, { at: now + ms, fn });
        return timerSeq;
    },
    /** @param {[unknown]} args */
    clearTimeout: (...args) => { timers.delete(Number(args[0])); },
});

/** @param {{predicate: () => boolean|Promise<boolean>, timeoutMs?: number}} arg0 */
async function waitFor({ predicate, timeoutMs = 20_000 }) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the scheduler');
        await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
}

/** Let the scheduler's promise chains settle. No clock time passes. */
const flush = async () => {
    for (let round = 0; round < 5; round += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

/**
 * One scheduler attempt, shaped the way `workflow.run()` receives it.
 * @param {{item: any, attempt?: number|null, runId: string}} arg0
 */
function attemptFor({ item, attempt = null, runId }) {
    /** @type {{count: number}} */
    const progress = { count: 0 };
    return {
        item, attempt, workspace: null, signal: new AbortController().signal,
        runContext: new RunContext({ runId }), reportProgress: () => { progress.count += 1; }, progress,
    };
}

async function main() {
    const { provider, toolModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });
    let apiCalls = 0;
    client.on('api_request', () => { apiCalls += 1; });

    log.header({ t: `Example 30 — An unattended queue (${provider})` });
    await rm(STATE_DIR, { recursive: true, force: true });
    await mkdir(STATE_DIR, { recursive: true });
    log.option({ name: 'state', value: STATE_DIR, source: 'boards, claims, attempt records and checkpoints' });
    log.option({ name: 'claim states', value: Object.values(CLAIM_STATES).join(', '), source: 'CLAIM_STATES' });
    log.option({
        name: 'defaults',
        value: `poll ${SCHEDULER_DEFAULTS.pollIntervalMs} ms · ${SCHEDULER_DEFAULTS.concurrency.global} slot(s) · retry ${SCHEDULER_DEFAULTS.retry.baseMs}/${SCHEDULER_DEFAULTS.retry.maxMs} ms`,
        source: 'SCHEDULER_DEFAULTS — this run overrides the poll interval and the slots',
    });

    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    // ── A · one board, three sources ─────────────────────────────────────────
    log.section({ t: 'A — one board, three sources' });
    log.info({ m: 'The scheduler never invents work. It asks a read-only source, normalizes what comes back, and only then dispatches.' });
    /** @type {Array<{source?: string, reason?: string}>} */
    const skipped = [];
    const emitter = new EventEmitter();
    emitter.on(EVENTS.WORK_ITEM.SKIPPED, (/** @type {any} */ event) => skipped.push(event));

    const memoryRows = [
        rawItem({ id: 'id-310', identifier: 'MER-310', priority: 3, createdAt: 2_000 }),
        rawItem({ id: 'id-311', identifier: 'MER-311', priority: 1, createdAt: 3_000 }),
        rawItem({ id: 'id-312', identifier: 'MER-312', state: 'Done' }),
        { id: 'id-31x', identifier: 'MER-31X', title: 'broken', state: 'Todo', dispatchable: 'yes' },
    ];
    const memory = createMemoryWorkSource({ items: memoryRows, eventEmitter: emitter });
    const memoryTodo = await memory.fetchByStates({ states: ['Todo'] });

    const boardDir = join(STATE_DIR, 'board');
    await mkdir(boardDir, { recursive: true });
    await writeFile(join(boardDir, 'MER-320.json'), JSON.stringify(rawItem({ id: 'MER-320', identifier: 'MER-320', priority: 1, createdAt: 1_000 })), 'utf8');
    await writeFile(join(boardDir, 'MER-321.json'), JSON.stringify({ ...rawItem({ identifier: 'MER-321' }), id: 'MER-999' }), 'utf8');
    const board = await createJsonFileWorkSource({ dir: boardDir, eventEmitter: emitter });
    const boardTodo = await board.fetchByStates({ states: ['Todo'] });
    await rm(join(boardDir, 'MER-320.json'));
    const gone = await board.fetchByIds({ ids: ['MER-320'] });

    /** @type {Array<{states: string[]}>} */
    const hostCalls = [];
    const host = createFunctionWorkSource({
        fetchByStates: async (/** @type {{states?: string[]}} */ { states }) => {
            hostCalls.push({ states: states ?? [] });
            return [rawItem({ id: 'id-330', identifier: 'MER-330', priority: null, createdAt: 500 })];
        },
        fetchByIds: async () => [],
        eventEmitter: emitter,
    });
    const empty = await host.fetchByStates({ states: [] });
    const hosted = await host.fetchByStates({ states: ['Todo'] });
    /** @type {any} */
    let hostError = null;
    try {
        await createFunctionWorkSource({ fetchByStates: async () => { throw new Error('the tracker said no'); }, fetchByIds: async () => [] }).fetchByStates({ states: ['Todo'] });
    } catch (err) { hostError = err; }

    const skippedReasons = skipped.map((entry) => entry.reason).join('/');
    log.list({
        title: 'the three sources',
        items: [
            `memory → ${memoryTodo.map((item) => item.identifier).join(', ')} · one malformed row skipped`,
            `json → ${boardTodo.map((item) => item.identifier).join(', ')} · one id mismatch refused · deleted file ${gone.length} left`,
            `function → ${hosted.map((item) => item.identifier).join(', ')} · ${hostCalls.length} host call; empty query stayed home`,
        ],
    });
    check({
        name: 'each adapter normalizes, filters by state and skips what it cannot use',
        ok: memoryTodo.map((item) => item.identifier).join(',') === 'MER-310,MER-311'
            && boardTodo.map((item) => item.identifier).join(',') === 'MER-320'
            && gone.length === 0 && empty.length === 0
            && hostCalls.length === 1 && hosted[0]?.identifier === 'MER-330'
            && hostError instanceof WorkSourceError && hostError.category === 'tracker_request'
            && !String(hostError.message).includes('the tracker said no')
            && skippedReasons.includes('malformed') && skippedReasons.includes('id_filename_mismatch'),
        detail: `skips ${skippedReasons} · host ${hostCalls.length} call · throw ${String(hostError?.name)}/${String(hostError?.category)}`,
    });

    const normalized = normalizeWorkItem({ raw: { ...rawItem({ identifier: 'MER-300', priority: 2 }), labels: ['Ops', ' ops ', 'Release'] }, source: 'example-board' });
    /** @type {any} */
    let malformed = null;
    try {
        normalizeWorkItem({ raw: { ...rawItem(), identifier: 42 }, source: 'example-board' });
    } catch (err) { malformed = err; }
    const ordered = sortForDispatch({ items: [...memoryTodo, ...hosted] });
    check({
        name: 'the record is frozen and the queue is ordered priority → age → id',
        ok: Object.isFrozen(normalized) && normalized.labels.join(',') === 'ops,release' && malformed instanceof WorkSourceError
            && ordered.map((item) => item.identifier).join(',') === 'MER-311,MER-310,MER-330',
        detail: `order ${ordered.map((item) => `${item.identifier} p${item.priority ?? '-'}`).join(', ')} · malformed ${malformed?.name ?? 'accepted'}`,
    });

    const memoryClaims = createMemoryClaimStore();
    const claimA = await memoryClaims.acquire({ workItemId: 'MER-340', owner: 'owner-a' });
    const claimB = await memoryClaims.acquire({ workItemId: 'MER-340', owner: 'owner-b' });
    const fileClaims = join(STATE_DIR, 'claims');
    await mkdir(fileClaims, { recursive: true });
    const fileFirst = await createFileClaimStore({ dir: fileClaims, hostId: 'host-a' }).acquire({ workItemId: 'MER-341', owner: 'owner-a' });
    const fileSecond = await createFileClaimStore({ dir: fileClaims, hostId: 'host-b' }).acquire({ workItemId: 'MER-341', owner: 'owner-b' });
    check({
        name: 'the second owner is refused in memory and on disk',
        ok: claimA === true && claimB === false && fileFirst === true && fileSecond === false,
        detail: `memory ${claimA}/${claimB} · file ${fileFirst}/${fileSecond}`,
    });

    // ── B · one heartbeat: live run, retry, park, budget ─────────────────────
    log.section({ t: 'B — one heartbeat: a live item, a retry, a park, a budget' });
    /** @type {Array<{name: string, payload: Record<string, any>}>} */
    const events = [];
    for (const name of [
        EVENTS.SCHEDULER.START, EVENTS.SCHEDULER.STOP, EVENTS.SCHEDULER.TICK, EVENTS.SCHEDULER.BUDGET_EXHAUSTED,
        EVENTS.WORK_ITEM.CLAIMED, EVENTS.WORK_ITEM.DISPATCHED, EVENTS.WORK_ITEM.COMPLETED,
        EVENTS.WORK_ITEM.FAILED, EVENTS.WORK_ITEM.RETRY_SCHEDULED, EVENTS.WORK_ITEM.PARKED, EVENTS.WORK_ITEM.RELEASED,
    ]) {
        emitter.on(name, (/** @type {Record<string, any>} */ payload) => events.push({ name, payload }));
    }
    /** @param {string} name */
    const payloadsOf = (name) => events.filter((entry) => entry.name === name).map((entry) => entry.payload);
    /** @param {string} identifier */
    const sequenceOf = (identifier) => events.filter((entry) => entry.payload.identifier === identifier).map((entry) => entry.name).join(' → ');

    const queueRows = [
        { id: 'q-live', identifier: 'LIVE-30', title: 'Answer the marker', state: 'Todo', dispatchable: true, priority: 1 },
        { id: 'q-flaky', identifier: 'FLAKY-30', title: 'Survive a vendor hiccup', state: 'Todo', dispatchable: true, priority: 2 },
        { id: 'q-denied', identifier: 'DENIED-30', title: 'Write with a read-only token', state: 'Todo', dispatchable: true, priority: 3 },
        { id: 'q-waiting', identifier: 'WAITING-30', title: 'Wait for the next budget', state: 'Backlog', dispatchable: true, priority: 4 },
    ];
    /** @type {string} */
    let liveSummary = '';
    /** @type {() => void} */
    let releaseLive = () => {};
    const liveDone = new Promise((resolve) => { releaseLive = () => resolve(undefined); });
    const engine = createEngineRunner({ engine: 'agentic', client, model: toolModel, tools: [], budget: { maxTotalTokens: 600 }, prompt: LIVE_PROMPT });
    const queueWorkflow = {
        /** @param {any} args */
        async run(args) {
            if (args.item.identifier === 'LIVE-30') {
                try {
                    const result = await engine.run(args);
                    liveSummary = String(result.summary ?? '').trim();
                    return result;
                } finally { releaseLive(); }
            }
            if (args.item.identifier === 'FLAKY-30' && args.attempt === 1) throw Object.assign(new Error('back off'), { code: 'rate_limit' });
            if (args.item.identifier === 'DENIED-30') throw Object.assign(new Error('read-only token'), { code: 'PERMISSION_DENIED' });
            return { status: 'completed', usage: { total_tokens: 1, input_tokens: 1, output_tokens: 0 } };
        },
    };
    const queue = new WorkScheduler({
        workSource: createMemoryWorkSource({ items: queueRows }),
        workflow: queueWorkflow,
        claims: createMemoryClaimStore(),
        clock: createClock(),
        eventEmitter: emitter,
        activeStates: ['Todo'],
        terminalStates: ['Done'],
        concurrency: { global: 1 },
        retry: { baseMs: 1_000, maxMs: 1_000 },
        continuation: { delayMs: 0, max: 0 },
        limits: { maxDispatches: 4 },
        stallTimeoutMs: 0,
        pollIntervalMs: 3_600_000,
    });
    try {
        await queue.start();
        await liveDone;
        await flush();
        log.assistant({ m: liveSummary || '(the live run returned no summary)' });
        warnEmptyAnswer({ answer: liveSummary, label: 'the live item' });
        const liveTotals = queue.snapshot().totals;
        check({
            name: 'one tick claimed the top item, a real run completed it and its spend reached the totals',
            ok: payloadsOf(EVENTS.SCHEDULER.TICK)[0]?.dispatched === 1
                && sequenceOf('LIVE-30') === [EVENTS.WORK_ITEM.CLAIMED, EVENTS.WORK_ITEM.DISPATCHED, EVENTS.WORK_ITEM.COMPLETED, EVENTS.WORK_ITEM.PARKED].join(' → ')
                && apiCalls > 0 && liveSummary.includes(`${MARKER}-LIVE`) && liveTotals.totalTokens > 0,
            detail: `${sequenceOf('LIVE-30')} · ${apiCalls} api_request · ${liveTotals.totalTokens} tokens`,
        });

        log.info({ m: 'FLAKY-30 throws `rate_limit` — transient infrastructure — so its claim is kept and a retry is queued, not parked. Advance the clock past the backoff and tick again.' });
        await queue.tick();
        await flush();
        const retryPayload = payloadsOf(EVENTS.WORK_ITEM.RETRY_SCHEDULED).find((payload) => payload.identifier === 'FLAKY-30') ?? null;
        now += 1_000;
        await queue.tick();
        await flush();
        const flakySequence = sequenceOf('FLAKY-30');
        check({
            name: 'a transient failure queues one retry and the retry completes',
            ok: retryPayload?.failureClass === 'transient_infrastructure' && retryPayload?.attempt === 2
                && flakySequence === [EVENTS.WORK_ITEM.CLAIMED, EVENTS.WORK_ITEM.DISPATCHED, EVENTS.WORK_ITEM.RETRY_SCHEDULED, EVENTS.WORK_ITEM.DISPATCHED, EVENTS.WORK_ITEM.COMPLETED, EVENTS.WORK_ITEM.PARKED].join(' → '),
            detail: `${flakySequence} · queued attempt ${String(retryPayload?.attempt)} in ${String(retryPayload?.delayMs)} ms`,
        });

        log.info({ m: 'DENIED-30 throws `PERMISSION_DENIED`. Waiting cannot grant a permission, so the first attempt fails and parks with no retry.' });
        await queue.tick();
        await flush();
        const deniedFailed = payloadsOf(EVENTS.WORK_ITEM.FAILED).find((payload) => payload.identifier === 'DENIED-30') ?? null;
        const deniedParked = payloadsOf(EVENTS.WORK_ITEM.PARKED).find((payload) => payload.identifier === 'DENIED-30') ?? null;
        check({
            name: 'a permission failure parks on the first attempt with no retry',
            ok: deniedFailed?.failureClass === 'permission_block' && deniedParked?.reason === 'non_retryable'
                && events.every((entry) => !(entry.name === EVENTS.WORK_ITEM.RETRY_SCHEDULED && entry.payload.identifier === 'DENIED-30')),
            detail: `${sequenceOf('DENIED-30')} · park ${String(deniedParked?.reason)}`,
        });

        log.info({ m: 'Four dispatches are spent (live, two FLAKY attempts, DENIED). Promote WAITING-30 and tick: it is fetched, eligible, and refused before it starts.' });
        queueRows[3].state = 'Todo';
        await queue.tick();
        await flush();
        const budgetEvent = payloadsOf(EVENTS.SCHEDULER.BUDGET_EXHAUSTED)[0] ?? null;
        const waitingEvents = events.filter((entry) => entry.payload.identifier === 'WAITING-30');
        check({
            name: 'the dispatch budget stops the fifth run before it starts',
            ok: budgetEvent?.limit === 'maxDispatches' && waitingEvents.length === 0,
            detail: `limit ${String(budgetEvent?.limit)} · dispatches ${String(budgetEvent?.totals?.dispatches)} · WAITING-30 events ${waitingEvents.length}`,
        });

        const counts = await queue.stop({ reason: 'example-done' });
        log.option({ name: 'stop', value: `drained ${counts.drained} · running ${counts.running} · parked ${counts.parked}`, source: 'scheduler.stop({ reason })' });
        check({
            name: 'stop() drains the work and releases every claim',
            ok: counts.drained === true && counts.running === 0 && queue.snapshot().claimed.length === 0,
            detail: `${JSON.stringify(counts)} · claimed [${queue.snapshot().claimed.join(',')}]`,
        });
    } finally {
        await queue.stop({ reason: 'example-cleanup' }).catch(() => {});
    }

    // ── C · a restart: what carries, what does not ───────────────────────────
    log.section({ t: 'C — a restart: the failure budget and the park survive' });
    const RESTART_ITEM = 'MER-RST';
    const restartDir = join(STATE_DIR, 'attempts');
    await mkdir(restartDir, { recursive: true });
    const restartRows = [{ id: 'id-rst', identifier: RESTART_ITEM, title: 'Survive a restart', state: 'Todo', dispatchable: true }];
    /** @type {string[]} */
    const restartCalls = [];
    let restartOutcome = 'fail';
    const restartWorkflow = {
        /** @param {{item: {identifier: string}, attempt: number|null}} arg0 */
        async run({ item, attempt }) {
            restartCalls.push(`${item.identifier}#${attempt}`);
            if (restartOutcome === 'fail') return { status: 'failed', error: { message: 'scripted failure' } };
            restartRows[0].state = 'Done';
            return { status: 'completed', summary: `ran ${item.identifier}` };
        },
    };
    const restartOptions = () => ({
        workSource: createMemoryWorkSource({ items: restartRows }),
        workflow: restartWorkflow,
        clock: createClock(),
        claims: createMemoryClaimStore(),
        activeStates: ['Todo'],
        terminalStates: ['Done'],
        continuation: { delayMs: 0, max: 0 },
        retry: { baseMs: 1_000, maxMs: 1_000 },
        limits: { maxAttemptsPerItem: 2 },
        pollIntervalMs: 3_600_000,
    });
    /** @type {WorkScheduler|null} */
    let started = null;
    try {
        const storeA = createFileAttemptStore({ dir: restartDir });
        const first = new WorkScheduler({ ...restartOptions(), attemptStore: storeA });
        started = first;
        await first.start();
        await waitFor({ predicate: () => first.snapshot().retrying.length === 1 });
        const recordA = await storeA.load({ identifier: RESTART_ITEM });
        log.option({ name: 'process 1', value: `calls [${restartCalls.join(', ')}] · record attempts ${String(recordA?.attempts)} · parked ${String(recordA?.parked)}`, source: 'createFileAttemptStore({ dir })' });
        check({
            name: 'the first attempt failed, is retrying, and the file store wrote one failure',
            ok: restartCalls.join(',') === `${RESTART_ITEM}#1` && recordA?.attempts === 1 && recordA?.parked === null,
            detail: `calls [${restartCalls.join(', ')}] · attempts ${String(recordA?.attempts)} · parked ${String(recordA?.parked)}`,
        });
        await first.stop();

        const storeB = createFileAttemptStore({ dir: restartDir });
        const second = new WorkScheduler({ ...restartOptions(), attemptStore: storeB });
        started = second;
        await second.start();
        await waitFor({ predicate: () => second.snapshot().parked.length === 1 });
        await waitFor({ predicate: async () => (await storeB.load({ identifier: RESTART_ITEM }))?.parked?.reason === 'attempts_exhausted' });
        const parkedB = second.snapshot().parked[0];
        check({
            name: 'the restarted scheduler got one more dispatch and parked as attempts_exhausted',
            ok: restartCalls.join(',') === `${RESTART_ITEM}#1,${RESTART_ITEM}#1`
                && second.snapshot().totals.dispatches === 1
                && parkedB?.reason === 'attempts_exhausted' && parkedB?.attempts === 2,
            detail: `calls [${restartCalls.join(', ')}] · dispatched ${second.snapshot().totals.dispatches} · ${String(parkedB?.reason)} · the ordinal restarted at 1`,
        });
        await second.stop();

        const storeC = createFileAttemptStore({ dir: restartDir });
        const third = new WorkScheduler({ ...restartOptions(), attemptStore: storeC });
        started = third;
        restartOutcome = 'complete';
        const callsBeforeThird = restartCalls.length;
        await third.start();
        await waitFor({ predicate: () => third.snapshot().parked.length === 1 });
        const callsBeforeReset = restartCalls.length;
        await third.resetItem({ identifier: RESTART_ITEM });
        const recordAfterReset = await storeC.load({ identifier: RESTART_ITEM });
        await third.tick();
        await waitFor({ predicate: () => third.snapshot().completed.length === 1 });
        const finalSnapshot = third.snapshot();
        log.option({
            name: 'process 3',
            value: `hydrated park ran ${callsBeforeReset - callsBeforeThird} call(s) · reset cleared ${recordAfterReset === null} · calls [${restartCalls.join(', ')}] · completed [${finalSnapshot.completed.join(', ')}]`,
            source: 'resetItem({ identifier }) then tick()',
        });
        check({
            name: 'resetItem clears the persisted park and the item completes from a clean budget',
            ok: callsBeforeReset === callsBeforeThird && recordAfterReset === null
                && restartCalls.at(-1) === `${RESTART_ITEM}#1` && finalSnapshot.completed.includes(RESTART_ITEM),
            detail: `record ${recordAfterReset === null ? 'cleared' : 'present'} · calls [${restartCalls.join(', ')}]`,
        });
    } finally {
        if (started !== null) await started.stop().catch(() => {});
    }

    // ── D · four engines, one attempt each ───────────────────────────────────
    log.section({ t: 'D — four engines, one attempt each' });
    log.info({ m: 'One item names the engine it wants; `createEngineRunner` builds it per attempt. The DAG saves a checkpoint in a finally block, so a second attempt restores it instead of paying again.' });
    const engineStore = new LocalFileSessionStore({ dir: join(STATE_DIR, 'checkpoints'), eventEmitter: client });
    /** @param {string} identifier */
    const engineItem = (identifier) => ({ id: identifier, identifier, title: `Engine ${identifier}`, state: 'Todo', dispatchable: true });
    const dagPlan = () => ({ objective: TASK, context: {}, steps: [{ id: 'answer', title: 'Answer', systemPrompt: 'Be brief.', userPromptTemplate: TASK }] });
    const stateGraph = () => ({ entry: 'only', nodes: [{ id: 'only', model: toolModel, terminal: true, systemPrompt: 'Be brief.', userPromptTemplate: TASK }], edges: [] });
    const engineBudget = { maxTotalTokens: 4_000 };

    const agenticRunner = createEngineRunner({ engine: 'agentic', client, model: toolModel, tools: [], budget: engineBudget, prompt: TASK });
    const dagRunner = createEngineRunner({ engine: 'dag', client, model: toolModel, budget: engineBudget, planFor: dagPlan, store: engineStore });
    const machineRunner = createEngineRunner({ engine: 'stateMachine', client, model: toolModel, budget: engineBudget, graphFor: stateGraph, store: engineStore });
    const discussionRunner = createEngineRunner({
        engine: 'discussion', client, model: toolModel, budget: engineBudget, objective: TASK,
        agents: [{ name: 'analyst', persona: 'You are a one-line analyst. At most 15 words.', model: toolModel, provider }],
    });

    const callsBeforeAgentic = apiCalls;
    const agenticResult = await agenticRunner.run(attemptFor({ item: engineItem('MER-30A'), runId: 'attempt-30-agentic' }));
    warnEmptyAnswer({ answer: agenticResult.summary, label: 'the agentic attempt' });
    check({
        name: 'agentic — one attempt, one real turn, its own usage',
        ok: agenticResult.status === 'completed' && apiCalls > callsBeforeAgentic && String(agenticResult.summary ?? '').trim().length > 0,
        detail: `${agenticResult.status} · ${apiCalls - callsBeforeAgentic} call(s) · ${JSON.stringify(agenticResult.usage)}`,
    });

    const callsBeforeDag = apiCalls;
    const dagFirst = await dagRunner.run(attemptFor({ item: engineItem('MER-30B'), attempt: 1, runId: 'attempt-30-dag-1' }));
    const dagCalls = apiCalls - callsBeforeDag;
    const callsBeforeResume = apiCalls;
    const dagResumed = await dagRunner.run(attemptFor({ item: engineItem('MER-30B'), attempt: 2, runId: 'attempt-30-dag-2' }));
    const resumeCalls = apiCalls - callsBeforeResume;
    const dagCheckpoint = /** @type {any} */ (await engineStore.load('work:MER-30B'));
    check({
        name: 'dag — the step ran, the checkpoint saved, and the resume restored it without a call',
        ok: dagFirst.status === 'completed' && dagCalls > 0 && dagCheckpoint?.checkpoint?.kind === 'workflow'
            && dagResumed.status === 'completed' && resumeCalls === 0
            && Number(/** @type {any} */ (dagResumed.usage)?.total_tokens ?? 0) === 0,
        detail: `${dagFirst.status} · ${dagCalls} call(s) · kind ${String(dagCheckpoint?.checkpoint?.kind)} · resume ${resumeCalls} call(s), usage ${JSON.stringify(dagResumed.usage)}`,
    });

    const machineArgs = attemptFor({ item: engineItem('MER-30C'), runId: 'attempt-30-machine' });
    const callsBeforeMachine = apiCalls;
    const machineResult = await machineRunner.run(machineArgs);
    const machineCheckpoint = /** @type {any} */ (await engineStore.load('work:MER-30C'));
    check({
        name: 'stateMachine — the graph ran, refreshed node progress and saved its checkpoint',
        ok: machineResult.status === 'completed' && apiCalls > callsBeforeMachine
            && machineArgs.progress.count >= 2 && machineCheckpoint?.checkpoint?.kind === 'stateMachine',
        detail: `${machineResult.status} · ${apiCalls - callsBeforeMachine} call(s) · progress ${machineArgs.progress.count} · kind ${String(machineCheckpoint?.checkpoint?.kind)}`,
    });

    const callsBeforeDiscussion = apiCalls;
    const discussionResult = await discussionRunner.run(attemptFor({ item: engineItem('MER-30D'), runId: 'attempt-30-discussion' }));
    warnEmptyAnswer({ answer: discussionResult.summary, label: 'the discussion' });
    log.assistant({ m: String(discussionResult.summary ?? '').trim() });
    check({
        name: 'discussion — a real verdict decides the status and no checkpoint is written',
        ok: (discussionResult.status === 'completed' || discussionResult.status === 'failed')
            && apiCalls > callsBeforeDiscussion && String(discussionResult.summary ?? '').trim().length > 0,
        detail: `${discussionResult.status} · ${apiCalls - callsBeforeDiscussion} call(s) · ${JSON.stringify(discussionResult.usage)}`,
    });

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'One board, one heartbeat, one durable budget, four engines — and the queue survived its own restart.' });
    else log.warn({ m: `${failures}/${checks} check(s) failed — inspect the log above.` });
}

runMain({ mainFn: main });
