// @ts-check
/**
 * Example 35 — The capstone: one unattended system, end to end.
 *
 * The whole coordination layer in one run. A JSON board holds three items, a
 * repository-owned `WORKFLOW.md` decides how they run, `createOrchestration`
 * builds the workspace, the engine, the scheduler and the operator from it, and
 * one approval gates both the session and the workspace shell. Live, a real
 * model works each item inside its own workspace and saves a per-item artifact.
 *
 *   A — one call           : the policy is started and healthy before the
 *       scheduler exists, the scheduler inherits the file's interval, states and
 *       caps, and the workspace manager, the runner, the ring and the handler
 *       all exist on one emitter.
 *   B — two items at once  : `start()` dispatches the board's first two items
 *       under a global cap of 2; both complete in their own workspace
 *       directories, and each `workspace:created` carries the same runId as its
 *       `work_item:dispatched`.
 *   C — the operator       : the HTTP state route reports the policy health and
 *       the live totals, the text page names the policy, and the detail route
 *       answers for one item; no response carries a title or a description.
 *   D — the cap holds      : with `max_dispatches: 2`, a third tick emits
 *       `scheduler:budget_exhausted` once and dispatches nothing.
 *   E — a broken edit      : a malformed `WORKFLOW.md` keeps the last good
 *       config, blocks the tick with `validation_error`, shows `healthy:false`
 *       with reasons on the operator, and records `reload_failed` in the ring.
 *   F — a valid save       : raising the dispatch cap applies live, the third
 *       item dispatches on the next tick, and no second budget event is emitted.
 *   G — stop               : one call closes the server, drains the scheduler,
 *       stops the policy and leaves no armed timer.
 *
 * Public API: `createOrchestration`, `createJsonFileWorkSource`, `EVENTS`,
 * `initializeClient`, `loadCredentials`, `log`.
 *
 * Run: `node test/examples/35_capstone.mjs` (live) · `node test/examples/35_capstone.mjs --offline` (deterministic)
 * Needs: `BACKEND` + provider credentials in `secret.env` for the live items;
 *        `--offline` needs none.
 *
 * @version 0.12.0
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENTS, initializeClient, loadCredentials, log } from 'merci-sdk';
import { createOrchestration } from 'merci-sdk/orchestration';
import { createJsonFileWorkSource } from 'merci-sdk/scheduler';
import { createAudit } from '../../examples/_shared/example-audit.mjs';
import { reportUsage, resolveExample, trackUsage, wireClient } from '../../examples/_shared/example-utils.mjs';

const OFFLINE = process.argv.includes('--offline');
const live = OFFLINE ? null : resolveExample();

const audit = createAudit({
    metaUrl: import.meta.url,
    id: 'audit/35_capstone',
    offline: OFFLINE,
    provider: live?.provider ?? null,
    models: live ? live.toolModel : null,
    title: 'Example 35 — The capstone',
});

/** @type {any} */
let activeSystem = null;

// ── the manual clock ─────────────────────────────────────────────────────────
let now = 1_000_000;
let seq = 0;
/** @type {Map<number, { at: number, fn: () => void }>} */
const timers = new Map();
const clock = {
    now: () => now,
    setTimeout: (/** @type {[() => void, number]} */ ...args) => {
        const [fn, ms] = args;
        const id = ++seq;
        timers.set(id, { at: now + ms, fn });
        return id;
    },
    clearTimeout: (/** @type {unknown} */ id) => { timers.delete(Number(id)); },
};

// ── the board ────────────────────────────────────────────────────────────────
const ITEMS = [
    { id: 'cap-1', identifier: 'MER-CAP-1', title: 'Capstone item one', state: 'Todo', dispatchable: true, priority: 1 },
    { id: 'cap-2', identifier: 'MER-CAP-2', title: 'Capstone item two', state: 'Todo', dispatchable: true, priority: 2 },
    { id: 'cap-3', identifier: 'MER-CAP-3', title: 'Capstone item three', state: 'Todo', dispatchable: true, priority: 3 },
];

/** @type {string} */
let dir = '';
/** @type {string} */
let workflowPath = '';
/** @type {string} */
let workspaceRoot = '';
/** @type {string} */
let boardDir = '';

/**
 * The repo-owned contract. `max_dispatches` caps the scheduler; the cap and the
 * interval are the two values the live reload demonstrates.
 * @param {{ intervalMs?: number, maxDispatches?: number, concurrency?: number, broken?: boolean }} [arg0]
 * @returns {string}
 */
const contract = ({ intervalMs = 3_600_000, maxDispatches = 2, concurrency = 2, broken = false } = {}) => {
    if (broken) return '---\ntracker: [not-a-map\n---\nthis file is broken';
    return [
        '---',
        'tracker:',
        '  kind: json',
        '  active_states: [Todo]',
        '  terminal_states: [Done]',
        'polling:',
        `  interval_ms: ${intervalMs}`,
        'workspace:',
        `  root: ${JSON.stringify(workspaceRoot)}`,
        'agent:',
        `  max_concurrent_agents: ${concurrency}`,
        'merci:',
        '  scheduler:',
        '    continuation_max: 0',
        `    max_dispatches: ${maxDispatches}`,
        '---',
        'Do this work item now.',
        '1. Call save_artifact with name "marker.md" and content "CAPSTONE-{{ issue.identifier }}".',
        '2. Then reply with exactly: CAPSTONE-{{ issue.identifier }}',
    ].join('\n');
};

// ── events ───────────────────────────────────────────────────────────────────
/** @type {Array<{ name: string, envelope: Record<string, any> }>} */
const events = [];
/** @type {(name: string) => number} */
const countOf = (name) => events.filter((entry) => entry.name === name).length;
/** @type {(name: string) => Array<Record<string, any>>} */
const payloadsOf = (name) => events.filter((entry) => entry.name === name).map((entry) => entry.envelope);

/**
 * The offline client: the runner's fluent contract with a scripted answer, so
 * the whole system is exercised without a model call.
 * @returns {{ session: (model: string) => Record<string, unknown> }}
 */
function offlineClient() {
    return {
        session: (/** @type {string} */ model) => {
            /** @type {Record<string, any>} */
            const session = {
                provider: 'offline',
                model,
                _lastRunUsage: { total_tokens: 6, cost_usd: 0 },
                withSessionStore() { return session; },
                withExecutionJournal() { return session; },
                withTools() { return session; },
                withBudget() { return session; },
                withApproval() { return session; },
                async loadCheckpoint() { return null; },
                async run(/** @type {{options?: Record<string, any>}} */ args) {
                    console.error('[DBG] offline run');
                    args?.options?.onEvent?.({ type: 'text', content: 'CAPSTONE-OFFLINE' });
                    return 'CAPSTONE-OFFLINE';
                },
            };
            return session;
        },
    };
}

/**
 * The whole demonstration.
 * @returns {Promise<void>}
 */
async function main() {
    dir = await mkdtemp(join(tmpdir(), 'merci-capstone-'));
    workspaceRoot = join(dir, 'workspaces');
    boardDir = join(dir, 'board');
    workflowPath = join(dir, 'WORKFLOW.md');
    await mkdir(boardDir, { recursive: true });
    for (const item of ITEMS) {
        await writeFile(join(boardDir, `${item.id}.json`), JSON.stringify(item));
    }
    await writeFile(workflowPath, contract());

    /** @type {Awaited<ReturnType<typeof initializeClient>>['client']|null} */
    let client = null;
    /** @type {ReturnType<typeof trackUsage>|null} */
    let usage = null;
    let apiCalls = 0;
    /** @type {Set<string>} */
    const completed = new Set();
    /** @type {Array<() => void>} */
    const waiters = [];

    /**
     * Resolve once `n` distinct items have completed.
     * @param {number} n -
     * @returns {Promise<'done'|'timeout'>}
     */
    const waitForCompleted = (n) => new Promise((resolve) => {
        if (completed.size >= n) { resolve('done'); return; }
        const timer = setTimeout(() => resolve('timeout'), 120_000);
        const waiter = () => {
            if (completed.size < n) return;
            clearTimeout(timer);
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            resolve('done');
        };
        waiters.push(waiter);
    });

    if (live !== null) {
        const initialized = await initializeClient({
            provider: live.provider,
            options: loadCredentials({ provider: live.provider }),
        });
        client = initialized.client;
        wireClient({ client });
        usage = trackUsage({ client });
        client.on('api_request', () => { apiCalls += 1; });
    }

    const workSource = await createJsonFileWorkSource({ dir: boardDir });
    const orchestration = await createOrchestration({
        client: /** @type {any} */ (client ?? offlineClient()),
        model: live?.toolModel ?? 'offline-model',
        workSource,
        workflowFile: workflowPath,
        policyOptions: { watch: false },
        approval: () => true,
        operator: true,
        scheduler: { clock, continuation: { delayMs: 0, max: 0 } },
        runner: { onEvent: (/** @type {Record<string, any>} */ event) => { if (event?.type) events.push({ name: 'engine', envelope: event }); } },
    });
    activeSystem = orchestration;

    for (const name of [
        EVENTS.WORK_ITEM.DISPATCHED, EVENTS.WORK_ITEM.COMPLETED, EVENTS.WORK_ITEM.PARKED,
        EVENTS.WORKSPACE.CREATED, EVENTS.ARTIFACT.SAVED,
        EVENTS.SCHEDULER.TICK, EVENTS.SCHEDULER.BUDGET_EXHAUSTED,
        EVENTS.SCHEDULER.CONFIGURED,
    ]) {
        orchestration.emitter.on(name, (/** @type {Record<string, any>} */ envelope) => {
            events.push({ name, envelope });
            if (name === EVENTS.WORK_ITEM.COMPLETED) {
                completed.add(String(envelope.identifier));
                for (const waiter of [...waiters]) waiter();
            }
        });
    }

    // ── A: one call wires the layer ──────────────────────────────────────────
    audit.scenario({
        id: 'A', title: 'one call wires the layer',
        goal: 'createOrchestration starts the policy first, then builds the workspace, the runner, the scheduler and the operator from the file',
        expect: 'policy started and healthy · interval 3600000 · active [Todo] · terminal [Done] · global cap 2 · a workspace manager, a ring and a handler exist · one approval is set',
        fails: [
            { code: 'policy-not-first', symptom: 'the factory rejected with not_started', hint: 'the policy must resolve before the scheduler is built' },
            { code: 'no-file-settings', symptom: 'the interval or the cap is not from the file', hint: 'policyToSchedulerOptions is the only source of scheduler construction values' },
            { code: 'no-operator', symptom: 'the ring or the handler is null', hint: 'operator: true builds both on the shared emitter' },
        ],
        input: { workflowFile: 'the temp contract', operator: true, concurrency: 2, maxDispatches: 2 },
    });

    const policyA = orchestration.policy.snapshot();
    const schedulerA = orchestration.scheduler.snapshot();
    audit.observe({ name: 'policy', value: { started: policyA.started, healthy: policyA.healthy } });
    audit.observe({ name: 'scheduler', value: { interval: schedulerA.pollIntervalMs, active: schedulerA.activeStates, terminal: schedulerA.terminalStates, limits: schedulerA.limits } });
    audit.check({
        name: 'the policy resolved first and is healthy',
        ok: policyA.started === true && policyA.healthy === true,
        detail: { expected: 'started true · healthy true', observed: `started ${policyA.started} · healthy ${policyA.healthy}` },
    });
    audit.check({
        name: 'the scheduler was built from the file, not from defaults',
        ok: schedulerA.pollIntervalMs === 3_600_000
            && schedulerA.activeStates.join(',') === 'Todo'
            && schedulerA.terminalStates.join(',') === 'Done'
            && schedulerA.limits.maxDispatches === 2,
        detail: {
            expected: '3600000 · Todo · Done · maxDispatches 2',
            observed: `${schedulerA.pollIntervalMs} · ${schedulerA.activeStates.join(',')} · ${schedulerA.terminalStates.join(',')} · maxDispatches ${String(schedulerA.limits.maxDispatches)}`,
        },
    });
    audit.check({
        name: 'the workspace, the ring and the handler all exist',
        ok: orchestration.workspace !== null && orchestration.ring !== null && orchestration.handler !== null,
        detail: {
            expected: 'workspace, ring and handler present',
            observed: `workspace ${orchestration.workspace !== null} · ring ${orchestration.ring !== null} · handler ${orchestration.handler !== null}`,
        },
    });
    audit.end();

    // ── B: two items at once ─────────────────────────────────────────────────
    audit.scenario({
        id: 'B', title: 'two items run at once, each in its own workspace',
        goal: 'start() dispatches under the global cap and each attempt is correlated with the workspace it creates',
        expect: '2 dispatched · MER-CAP-1 and MER-CAP-2 complete · each has a directory under the file root · workspace:created.runId equals its dispatched runId',
        fails: [
            { code: 'serial', symptom: 'only one item dispatched', hint: 'the global cap and the file both say 2' },
            { code: 'shared-workspace', symptom: 'two items share a workspace path', hint: 'one directory per item, keyed by the identifier' },
            { code: 'uncorrelated', symptom: 'workspace:created has no runId', hint: 'the scheduler wraps workspace calls in runWithRunContext' },
        ],
        input: { items: ['MER-CAP-1', 'MER-CAP-2'], cap: 2 },
    });

    await orchestration.start();
    const twoDone = await waitForCompleted(2);
    const dispatchedB = payloadsOf(EVENTS.WORK_ITEM.DISPATCHED);
    const workspaceB = payloadsOf(EVENTS.WORKSPACE.CREATED);
    const runIdOf = (/** @type {string} */ identifier) => dispatchedB.find((entry) => entry.identifier === identifier)?.runId ?? null;
    const correlated = ['MER-CAP-1', 'MER-CAP-2'].every((identifier) => workspaceB.some((entry) => entry.workItemId === identifier && entry.runId === runIdOf(identifier)));
    audit.observe({ name: 'dispatched', value: dispatchedB.map((entry) => `${entry.identifier}:${String(entry.runId)}`).join(' · ') });
    audit.observe({ name: 'workspaces', value: workspaceB.map((entry) => `${entry.workItemId}:${String(entry.runId)}`).join(' · ') });
    audit.check({
        name: 'both items dispatched and completed',
        ok: twoDone === 'done' && dispatchedB.length === 2 && completed.has('MER-CAP-1') && completed.has('MER-CAP-2'),
        detail: { expected: '2 dispatched · both completed', observed: `${dispatchedB.length} dispatched · completed [${[...completed].join(',')}] · ${twoDone}` },
    });
    audit.check({
        name: 'each item got its own workspace and its runId matches the attempt',
        ok: workspaceB.length === 2 && correlated
            && new Set(workspaceB.map((entry) => entry.path)).size === 2,
        detail: {
            expected: '2 distinct workspace paths, each runId equal to its dispatched runId',
            observed: `${workspaceB.length} created · distinct ${new Set(workspaceB.map((entry) => entry.path)).size} · correlated ${correlated}`,
        },
    });
    audit.end();

    // ── C: the operator sees the system ──────────────────────────────────────
    audit.scenario({
        id: 'C', title: 'the operator reports the live system',
        goal: 'the HTTP surface answers from the live scheduler and the policy snapshot, not from a fixture',
        expect: 'GET /api/v1/state: 200, policy.healthy true, 2 completed · GET /: 200 and the text names the policy · GET /api/v1/items/MER-CAP-1: 200 · POST /api/v1/refresh: 200 · no response carries a title or description',
        fails: [
            { code: 'fixture', symptom: 'the state disagrees with the snapshot', hint: 'getSnapshot reads the live scheduler' },
            { code: 'no-policy', symptom: 'the state has no policy block', hint: 'getPolicySnapshot feeds the projection' },
            { code: 'leak', symptom: 'a response carries item prose', hint: 'the operator exposes identifiers and codes only' },
        ],
        input: { routes: ['/api/v1/state', '/', '/api/v1/items/MER-CAP-1'] },
    });

    const listening = await orchestration.listen();
    const stateResponse = await fetch(`${listening.url}/api/v1/state`);
    const state = /** @type {any} */ (await stateResponse.json());
    const pageResponse = await fetch(`${listening.url}/`);
    const page = await pageResponse.text();
    const detailResponse = await fetch(`${listening.url}/api/v1/items/MER-CAP-1`);
    const refreshResponse = await fetch(`${listening.url}/api/v1/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
    });
    const serialized = JSON.stringify(state) + page;
    audit.observe({ name: 'state', value: { status: stateResponse.status, policy: state.policy, counts: state.counts, totals: state.totals } });
    audit.check({
        name: 'the state route reports the live policy and the completed count',
        ok: stateResponse.status === 200 && state.policy?.healthy === true
            && state.counts?.completed === 2,
        detail: {
            expected: '200 · policy.healthy true · counts.completed 2',
            observed: `${stateResponse.status} · healthy ${String(state.policy?.healthy)} · completed ${String(state.counts?.completed)}`,
        },
    });
    audit.check({
        name: 'the text page names the policy and the item detail route answers',
        ok: pageResponse.status === 200 && page.includes('Policy:') && detailResponse.status === 200,
        detail: { expected: '200 page with "Policy:" · detail 200', observed: `${pageResponse.status} · has Policy ${page.includes('Policy:')} · detail ${detailResponse.status}` },
    });
    audit.check({
        name: 'refresh answers and no response carries item prose',
        ok: (refreshResponse.status === 200 || refreshResponse.status === 202) && !serialized.includes('Capstone item'),
        detail: {
            expected: 'refresh 200/202 · no title text',
            observed: `refresh ${refreshResponse.status} · prose leaked ${serialized.includes('Capstone item')}`,
        },
    });
    audit.end();

    // ── D: the dispatch cap holds ────────────────────────────────────────────
    audit.scenario({
        id: 'D', title: 'the dispatch cap stops new work',
        goal: 'the budget guard is a stop-new-work threshold, not a reservation, and it reports itself once',
        expect: 'a tick after two dispatches emits scheduler:budget_exhausted once with reason maxDispatches · MER-CAP-3 is not dispatched',
        fails: [
            { code: 'over-dispatch', symptom: 'MER-CAP-3 dispatched past the cap', hint: 'limits.maxDispatches gates the third item' },
            { code: 'no-event', symptom: 'no budget_exhausted event', hint: 'the guard emits once per scheduler lifetime' },
            { code: 'event-spam', symptom: 'the event fired more than once', hint: 'the operator already has the fact; it is emitted once' },
        ],
        input: { maxDispatches: 2, items: 3 },
    });

    await orchestration.scheduler.tick();
    const budgetD = payloadsOf(EVENTS.SCHEDULER.BUDGET_EXHAUSTED);
    const dispatchedD = payloadsOf(EVENTS.WORK_ITEM.DISPATCHED);
    audit.observe({ name: 'budget', value: budgetD.map((entry) => entry.limit).join(',') });
    audit.check({
        name: 'the third item is held and the guard reports maxDispatches once',
        ok: budgetD.length === 1 && budgetD[0]?.limit === 'maxDispatches'
            && dispatchedD.filter((entry) => entry.identifier === 'MER-CAP-3').length === 0,
        detail: {
            expected: '1 budget event · limit maxDispatches · no MER-CAP-3 dispatch',
            observed: `${budgetD.length} event(s) · limit ${String(budgetD[0]?.limit)} · MER-CAP-3 dispatches ${dispatchedD.filter((entry) => entry.identifier === 'MER-CAP-3').length}`,
        },
    });
    audit.end();

    // ── E: a broken edit is visible, never half-applied ──────────────────────
    audit.scenario({
        id: 'E', title: 'a broken edit is visible and never half-applied',
        goal: 'reload() keeps the last good config, the tick is blocked by the policy preflight, and the operator explains why',
        expect: 'reload: healthy false, applied null, reasons non-empty · a tick returns validation_error · state.policy.healthy false with reasons · the page says "Policy: failed" · the ring holds reload_failed · the interval stays 3600000',
        fails: [
            { code: 'half-applied', symptom: 'the scheduler interval changed', hint: 'only a healthy, changed mapping is applied' },
            { code: 'silent', symptom: 'the state still says healthy', hint: 'state.policy is the health projection' },
            { code: 'idle-looking', symptom: 'the tick did not report validation_error', hint: 'the policy preflight blocks the tick while the file is broken' },
        ],
        input: { broken: 'invalid front matter', intactInterval: 3_600_000 },
    });

    await writeFile(workflowPath, contract({ broken: true }));
    const brokenE = await orchestration.reload();
    const ticksBefore = countOf(EVENTS.SCHEDULER.TICK);
    await orchestration.scheduler.tick();
    const tickE = countOf(EVENTS.SCHEDULER.TICK) > ticksBefore ? payloadsOf(EVENTS.SCHEDULER.TICK).at(-1) : null;
    const stateE = /** @type {any} */ (await (await fetch(`${listening.url}/api/v1/state`)).json());
    const pageE = await (await fetch(`${listening.url}/`)).text();
    const ringE = /** @type {Array<Record<string, any>>} */ (orchestration.ring?.list({ limit: 100 }) ?? []);
    audit.observe({ name: 'reload', value: { healthy: brokenE.healthy, applied: brokenE.applied, reasons: brokenE.reasons } });
    audit.check({
        name: 'the broken reload is refused and the interval is untouched',
        ok: brokenE.healthy === false && brokenE.applied === null
            && brokenE.reasons.length > 0 && orchestration.scheduler.snapshot().pollIntervalMs === 3_600_000,
        detail: {
            expected: 'healthy false · applied null · reasons non-empty · interval 3600000',
            observed: `healthy ${brokenE.healthy} · applied ${String(brokenE.applied)} · reasons ${brokenE.reasons.length} · interval ${orchestration.scheduler.snapshot().pollIntervalMs}`,
        },
    });
    audit.check({
        name: 'the tick is blocked with validation_error',
        ok: tickE?.outcome === 'validation_error',
        detail: { expected: 'validation_error', observed: String(tickE?.outcome ?? '(no tick)') },
    });
    audit.check({
        name: 'the operator shows the unhealthy policy and the ring kept the record',
        ok: stateE.policy?.healthy === false && (stateE.policy?.reasons ?? []).length > 0
            && pageE.includes('Policy: failed')
            && ringE.some((entry) => String(entry.event ?? '').includes('workflow_policy:reload_failed')),
        detail: {
            expected: 'state healthy false · reasons > 0 · page "Policy: failed" · ring reload_failed',
            observed: `healthy ${String(stateE.policy?.healthy)} · reasons ${(stateE.policy?.reasons ?? []).length} · page ${pageE.includes('Policy: failed')} · ring ${ringE.length}`,
        },
    });
    audit.end();

    // ── F: a valid save resumes with no restart ──────────────────────────────
    audit.scenario({
        id: 'F', title: 'a valid save raises the cap and resumes dispatch',
        goal: 'a healthy, changed edit applies live through applyConfig and the third item runs on the next tick',
        expect: 'reload: healthy true and changed · interval 7200000 · one scheduler:configured · the next tick dispatches MER-CAP-3 · it completes · still one budget event',
        fails: [
            { code: 'no-apply', symptom: 'the interval stayed 3600000', hint: 'a healthy, changed reload applies the mapping' },
            { code: 'no-resume', symptom: 'MER-CAP-3 never dispatched', hint: 'raising maxDispatches frees the guard' },
            { code: 'second-event', symptom: 'a second budget_exhausted was emitted', hint: 'the event is once per scheduler lifetime' },
        ],
        input: { intervalMs: 7_200_000, maxDispatches: 5 },
    });

    await writeFile(workflowPath, contract({ intervalMs: 7_200_000, maxDispatches: 5 }));
    const healthyF = await orchestration.reload();
    const configuredF = countOf(EVENTS.SCHEDULER.CONFIGURED);
    await orchestration.scheduler.tick();
    const thirdDone = await waitForCompleted(3);
    audit.observe({ name: 'reload', value: { healthy: healthyF.healthy, changed: healthyF.changed, applied: healthyF.applied } });
    audit.check({
        name: 'the valid edit applies live',
        ok: healthyF.healthy === true && healthyF.changed === true
            && orchestration.scheduler.snapshot().pollIntervalMs === 7_200_000
            && configuredF >= 1,
        detail: {
            expected: 'healthy true · changed true · interval 7200000 · >= 1 configured',
            observed: `healthy ${healthyF.healthy} · changed ${healthyF.changed} · interval ${orchestration.scheduler.snapshot().pollIntervalMs} · configured ${configuredF}`,
        },
    });
    audit.check({
        name: 'the third item dispatches and completes, with no second budget event',
        ok: thirdDone === 'done' && completed.has('MER-CAP-3') && countOf(EVENTS.SCHEDULER.BUDGET_EXHAUSTED) === 1,
        detail: {
            expected: 'MER-CAP-3 completed · 1 budget event',
            observed: `completed [${[...completed].join(',')}] · ${countOf(EVENTS.SCHEDULER.BUDGET_EXHAUSTED)} budget event(s)`,
        },
    });
    audit.end();

    // ── G: stop ──────────────────────────────────────────────────────────────
    audit.scenario({
        id: 'G', title: 'stop is one call and leaves nothing behind',
        goal: 'stop() closes the server, drains the scheduler, stops the policy and clears the timer',
        expect: 'the server stops answering · the scheduler drained · the policy stopped · 0 armed timers',
        fails: [
            { code: 'server-open', symptom: 'a request after stop still answers', hint: 'stop() closes the server it opened' },
            { code: 'policy-running', symptom: 'policy.snapshot().started is still true', hint: 'stop() stops the policy' },
            { code: 'timer-leak', symptom: 'an armed timer remains', hint: 'stop() clears the poll timer' },
        ],
        input: { reason: 'example-done' },
    });

    const countsG = await orchestration.stop();
    activeSystem = null;
    const pageAfterStop = await fetch(`${listening.url}/`).then(() => 'answered').catch(() => 'refused');
    const policyG = orchestration.policy.snapshot();
    audit.observe({ name: 'stop', value: { counts: countsG, policyStarted: policyG.started, policyStopped: policyG.stopped, timers: timers.size } });
    audit.check({
        name: 'the scheduler drained and the policy stopped',
        ok: countsG.drained === true && countsG.running === 0 && policyG.stopped === true,
        detail: {
            expected: 'drained true · running 0 · policy stopped true',
            observed: `${JSON.stringify(countsG)} · policy stopped ${String(policyG.stopped)}`,
        },
    });
    audit.check({
        name: 'the server closed and no timer is armed',
        ok: pageAfterStop === 'refused' && timers.size === 0,
        detail: { expected: 'refused · 0 timers', observed: `${pageAfterStop} · ${timers.size} timer(s)` },
    });
    audit.end();

    // ── live proof: the model worked each item and saved its artifact ────────
    if (live !== null) {
        audit.scenario({
            id: 'L', title: 'the live system worked every item',
            goal: 'each live attempt ran a real model turn inside its own workspace and saved a per-item artifact',
            expect: '> 0 api_request · each completed item has an artifact whose content is CAPSTONE-<identifier>',
            fails: [
                { code: 'no-call', symptom: 'apiCalls is 0', hint: 'live needs a backend and credentials' },
                { code: 'no-artifact', symptom: 'an item has no artifact', hint: 'the prompt asks the model to call save_artifact' },
                { code: 'wrong-marker', symptom: 'the artifact does not carry the item marker', hint: 'the rendered prompt names the identifier' },
            ],
            input: { items: ['MER-CAP-1', 'MER-CAP-2', 'MER-CAP-3'] },
        });

        const identifiers = ['MER-CAP-1', 'MER-CAP-2', 'MER-CAP-3'];
        /** @type {string[]} */
        const marks = [];
        for (const identifier of identifiers) {
            const handle = orchestration.workspace?.handleFor({ workItemId: identifier });
            if (!handle) { marks.push(`${identifier}:no-handle`); continue; }
            // `createWorkspaceTools` puts the artifact directory beside the
            // workspace as `<key>.artifacts`; the tool writes `marker.md` there.
            const artifact = join(handle.root, `${handle.key}.artifacts`, 'marker.md');
            try {
                const content = readFileSync(artifact, 'utf8');
                marks.push(`${identifier}:${content.includes(`CAPSTONE-${identifier}`)}`);
            } catch {
                marks.push(`${identifier}:missing`);
            }
        }
        audit.observe({ name: 'artifacts', value: marks });
        audit.check({
            name: 'every live item ran and saved its forced marker',
            ok: apiCalls >= 3 && marks.length >= 3 && marks.every((entry) => entry.endsWith(':true')),
            detail: {
                expected: '>= 3 api_request · 3 artifacts, each with CAPSTONE-<identifier>',
                observed: `${apiCalls} api_request · ${marks.join(' · ') || '(none)'}`,
            },
        });
        if (usage !== null) reportUsage({ provider: live.provider, usage });
        audit.end();
    }

    log.success({ m: 'Capstone verified: one call, a concurrent run, the operator, a cap, a broken edit, a live recovery and a clean stop.' });
    await rm(dir, { recursive: true, force: true });
}

// The await matters: without it a stalled round would exit 0 with a truncated log.
try {
    await audit.run(main);
} finally {
    if (activeSystem !== null) await activeSystem.stop().catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
}
