// @ts-check
/**
 * Example 34 — The coordination layer: one call, four primitives.
 *
 * `createOrchestration` is the composition root. This example proves the seams
 * it owns rather than the primitives (28–33 cover those): the policy resolves
 * before the scheduler is built, the workspace manager comes from the file, one
 * emitter feeds both the scheduler and the operator ring, one approval binds
 * both gates, a workspace event joins the attempt that created it, and a broken
 * `WORKFLOW.md` is visible on the operator surface instead of looking idle.
 *
 *   A — one call wires the layer  : the policy is started and healthy, the
 *       scheduler inherits the file's interval and states, and the workspace
 *       manager, the ring and the handler all exist.
 *   B — one attempt, joined      : `start()` dispatches one item under a global
 *       cap of 1, the workspace directory is created under the file's root, and
 *       `workspace:created` carries the same runId as `work_item:dispatched`.
 *   C — a broken edit is visible : `reload()` keeps the last good config, the
 *       tick is `validation_error`, the operator state says `policy.healthy:
 *       false` with its reasons, the status page says `Policy: failed`, and the
 *       ring holds the `workflow_policy:reload_failed` record. A valid save
 *       resumes dispatch with no restart.
 *   D — stop is one call        : the server closes, the scheduler drains, the
 *       policy stops, and no timer is left armed.
 *
 * Public API: `createOrchestration`, `EVENTS`, `initializeClient`, `log`.
 *
 * Run: `node test/examples/34_orchestration.mjs` (live) · `node test/examples/34_orchestration.mjs --offline` (deterministic)
 * Needs: `BACKEND` + provider credentials in `secret.env` for the live engine;
 *        `--offline` needs none.
 *
 * @version 0.12.0
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENTS, initializeClient, loadCredentials, log } from 'merci-sdk';
import { createOrchestration } from 'merci-sdk/orchestration';
import { createMemoryWorkSource } from 'merci-sdk/scheduler';
import { createAudit } from '../../examples/_shared/example-audit.mjs';
import { reportUsage, resolveExample, trackUsage, wireClient } from '../../examples/_shared/example-utils.mjs';

const OFFLINE = process.argv.includes('--offline');
const live = OFFLINE ? null : resolveExample();

const audit = createAudit({
    metaUrl: import.meta.url,
    id: 'audit/34_orchestration',
    offline: OFFLINE,
    provider: live?.provider ?? null,
    models: live ? live.toolModel : null,
    title: 'Example 34 — The coordination layer',
});

/** @type {Awaited<ReturnType<typeof createOrchestration>>|null} */
/** @type {any} */
let active = null;

// ── the manual clock ─────────────────────────────────────────────────────────
// Nothing fires on its own: the poll interval is an hour and every tick is
// explicit, so the demo cannot depend on wall-clock timing.
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
    clearTimeout: (/** @type {[unknown]} */ ...args) => { timers.delete(Number(args[0])); },
};

// ── the repo-owned contract ──────────────────────────────────────────────────
/** @type {string} */
let dir = '';
/** @type {string} */
let workflowPath = '';
/** @type {string} */
let workspaceRoot = '';

/**
 * A minimal `WORKFLOW.md`: one active state, one terminal state, one lane, no
 * continuations, and the workspace root under this run's temp directory.
 * @param {{ intervalMs?: number }} [arg0]
 * @returns {string}
 */
const contract = ({ intervalMs = 3_600_000 } = {}) => [
    '---',
    'tracker:',
    '  kind: memory',
    '  active_states: [Todo]',
    '  terminal_states: [Done]',
    'polling:',
    `  interval_ms: ${intervalMs}`,
    'workspace:',
    `  root: ${JSON.stringify(workspaceRoot)}`,
    'agent:',
    '  max_concurrent_agents: 1',
    'merci:',
    '  scheduler:',
    '    continuation_max: 0',
    '---',
    'Work on {{ issue.identifier }}.',
    '1. Call save_artifact with name "marker.md" and content "ORCH-{{ issue.identifier }}".',
    '2. Then reply with exactly: ORCH-{{ issue.identifier }}',
].join('\n');

// ── the board ────────────────────────────────────────────────────────────────
// Captured by reference, so this is the tracker: the scheduler never writes it.
const items = [
    { id: 'id-32a', identifier: 'MER-32A', title: 'Coordination item A', state: 'Todo', dispatchable: true, priority: 1 },
    { id: 'id-32b', identifier: 'MER-32B', title: 'Coordination item B', state: 'Todo', dispatchable: true, priority: 2 },
];

// ── the engine client ────────────────────────────────────────────────────────
/**
 * The offline client. Its session speaks the runner's fluent contract and
 * reports usage, so the wiring is exercised without a model call.
 * @returns {{session: (model: string) => Record<string, unknown>}}
 */
const offlineClient = () => ({
    session: (model) => {
        /** @type {Record<string, unknown>} */
        const session = {
            provider: 'openai',
            model,
            _lastRunUsage: { inputTokens: 4, outputTokens: 3, totalTokens: 7, costUsd: 0 },
            withSessionStore: () => session,
            withExecutionJournal: () => session,
            withTools: () => session,
            withBudget: () => session,
            withApproval: () => session,
            loadCheckpoint: async () => null,
            run: async () => 'ORCH-OFFLINE-OK',
        };
        return session;
    },
});

/**
 * Wait for real filesystem work, not just microtasks.
 * @param {{predicate: () => boolean, timeoutMs?: number}} arg0 -
 * @returns {Promise<void>}
 */
const waitFor = async ({ predicate, timeoutMs = 15_000 }) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

/** @type {Array<Record<string, unknown>>} */
const events = [];

/**
 * The first captured envelope with this name, or null.
 * @param {string} name
 * @returns {Record<string, unknown>|null}
 */
const first = (name) => events.find((entry) => entry.event === name) ?? null;

/**
 * Every captured envelope with this name.
 * @param {string} name
 * @returns {Array<Record<string, unknown>>}
 */
const all = (name) => events.filter((entry) => entry.event === name);

async function main() {
    dir = await mkdtemp(join(tmpdir(), 'merci-example-34-'));
    workspaceRoot = join(dir, 'workspaces');
    workflowPath = join(dir, 'WORKFLOW.md');
    await writeFile(workflowPath, contract());

    /** @type {ReturnType<typeof trackUsage>|null} */
    let usage = null;
    /** @type {Record<string, unknown>} */
    let client = offlineClient();
    let apiCalls = 0;
    if (live !== null) {
        const initialized = await initializeClient({
            provider: live.provider,
            options: loadCredentials({ provider: live.provider }),
        });
        client = /** @type {any} */ (initialized.client);
        wireClient({ client: /** @type {any} */ (client) });
        usage = trackUsage({ client: /** @type {any} */ (client) });
        (/** @type {any} */ (client)).on('api_request', () => { apiCalls += 1; });
    }

    log.option({ name: 'contract', value: workflowPath, source: 'written for this run' });
    log.option({ name: 'workspace root', value: workspaceRoot, source: 'workspace.root in the contract' });
    log.option({ name: 'engine', value: 'agentic', source: 'defaulted from the contract (merci.engine.kind)' });

    // ── A: one call wires the layer ──────────────────────────────────────────
    audit.scenario({
        id: 'A', title: 'one call wires the layer',
        goal: 'createOrchestration starts the policy, then builds the workspace, the runner, the scheduler and the operator from it',
        expect: 'policy started and healthy · scheduler pollIntervalMs 3600000 and activeStates [Todo] from the file · a workspace manager, a ring and a handler exist · one emitter feeds all of them',
        fails: [
            { code: 'policy-first', symptom: 'the factory rejected with not_started', hint: 'policy.start() runs before policyToSchedulerOptions(); the mapping refuses an unstarted policy' },
            { code: 'no-file-settings', symptom: 'pollIntervalMs is not 3600000', hint: 'the scheduler is built from policyToSchedulerOptions(), not from defaults' },
            { code: 'no-operator', symptom: 'the ring or the handler is null', hint: 'operator: true builds both against the same emitter' },
        ],
        input: { workflowFile: 'a minimal contract', operator: true, engine: null },
    });

    const orchestration = await createOrchestration({
        client: /** @type {any} */ (client),
        model: live?.toolModel ?? 'offline-model',
        workSource: createMemoryWorkSource({ items }),
        workflowFile: workflowPath,
        policyOptions: { watch: false },
        // One approval binds the session gate and the workspace shell gate;
        // denying is the safe demo value.
        approval: () => false,
        operator: true,
        scheduler: { clock }
    });
    active = orchestration;
    orchestration.emitter.onAny((/** @type {Record<string, unknown>} */ envelope) => { events.push(envelope); });

    const policyA = orchestration.policy.snapshot();
    const snapshotA = orchestration.scheduler.snapshot();
    audit.observe({ name: 'policy', value: { started: policyA.started, healthy: policyA.healthy, watch: policyA.watch } });
    audit.observe({ name: 'scheduler', value: { pollIntervalMs: snapshotA.pollIntervalMs, activeStates: snapshotA.activeStates } });
    audit.check({
        name: 'the policy resolved first and is healthy',
        ok: policyA.started === true && policyA.healthy === true,
        detail: { expected: 'started true · healthy true', observed: `started ${policyA.started} · healthy ${policyA.healthy}` },
    });
    audit.check({
        name: 'the scheduler inherited the file interval and states',
        ok: snapshotA.pollIntervalMs === 3_600_000
            && snapshotA.activeStates.join(',') === 'Todo'
            && snapshotA.terminalStates.join(',') === 'Done',
        detail: {
            expected: 'pollIntervalMs 3600000 · active [Todo] · terminal [Done]',
            observed: `pollIntervalMs ${snapshotA.pollIntervalMs} · active [${snapshotA.activeStates.join(',')}] · terminal [${snapshotA.terminalStates.join(',')}]`,
        },
    });
    audit.check({
        name: 'the workspace manager, the ring and the handler are wired',
        ok: orchestration.workspace !== null && orchestration.ring !== null && typeof orchestration.handler === 'function',
        detail: {
            expected: 'workspace, ring and handler present',
            observed: `workspace ${orchestration.workspace === null ? 'null' : 'present'} · ring ${orchestration.ring === null ? 'null' : 'present'} · handler ${typeof orchestration.handler}`,
        },
    });
    audit.end();

    // ── B: one attempt, joined to its workspace ──────────────────────────────
    audit.scenario({
        id: 'B', title: 'one attempt, joined to its workspace',
        goal: 'start() dispatches one item under a global cap of 1, and the workspace event carries the attempt runId',
        expect: 'one work_item:dispatched for MER-32A · workspace:created under the contract root · created.runId equals dispatched.runId · one dispatch in the totals · MER-32A completed',
        fails: [
            { code: 'no-dispatch', symptom: 'the board row stayed Todo', hint: 'the work source was built with activeStates; the scheduler fetches the policy states' },
            { code: 'unjoined', symptom: 'workspace:created has runId null', hint: 'the scheduler runs the workspace calls under the attempt RunContext' },
            { code: 'wrong-root', symptom: 'the directory is not under workspace.root', hint: 'the manager is built from policyToWorkspaceOptions(), and root is a top-level workspace key' },
        ],
        input: { concurrency: { global: 1 }, workspace: 'directory' },
    });

    await orchestration.start();
    await waitFor({ predicate: () => orchestration.scheduler.snapshot().completed.includes('MER-32A') });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const snapshotB = orchestration.scheduler.snapshot();
    const dispatchedB = first(EVENTS.WORK_ITEM.DISPATCHED);
    const createdB = first(EVENTS.WORKSPACE.CREATED);
    const createdPath = typeof createdB?.path === 'string' ? createdB.path : '';
    audit.observe({ name: 'dispatched', value: dispatchedB?.identifier ?? null });
    audit.observe({ name: 'workspace', value: { path: createdPath, runId: createdB?.runId ?? null } });
    audit.check({
        name: 'exactly one item was dispatched',
        ok: all(EVENTS.WORK_ITEM.DISPATCHED).length === 1 && dispatchedB?.identifier === 'MER-32A',
        detail: {
            expected: '1 dispatch · MER-32A',
            observed: `${all(EVENTS.WORK_ITEM.DISPATCHED).length} dispatch · ${String(dispatchedB?.identifier)}`,
        },
    });
    audit.check({
        name: 'the workspace was created under the contract root',
        ok: createdPath !== '' && existsSync(createdPath)
            && createdPath.startsWith(realpathSync(workspaceRoot)),
        detail: {
            expected: `an existing directory under ${workspaceRoot}`,
            observed: createdPath === '' ? 'no workspace:created event' : createdPath,
        },
    });
    audit.check({
        name: 'the workspace event joins the attempt that created it',
        ok: createdB !== null && dispatchedB !== null && createdB.runId === dispatchedB.runId,
        detail: {
            expected: 'created.runId === dispatched.runId',
            observed: `${String(createdB?.runId)} vs ${String(dispatchedB?.runId)}`,
        },
    });
    audit.check({
        name: 'the attempt completed and is counted once',
        ok: snapshotB.completed.includes('MER-32A') && snapshotB.totals.dispatches === 1,
        detail: {
            expected: 'completed [MER-32A] · dispatches 1',
            observed: `completed [${snapshotB.completed.join(',')}] · dispatches ${snapshotB.totals.dispatches}`,
        },
    });
    audit.check({
        name: 'no event carries an item title or description',
        ok: events.every((entry) => !JSON.stringify(entry).includes('Coordination item')),
        detail: { expected: 'no item prose in any envelope', observed: `${events.length} envelopes scanned` },
    });
    if (live !== null) {
        // The live proof is the model acting through the workspace, not merely a
        // vendor call: the rendered prompt forces one artifact write.
        const handle = orchestration.workspace?.handleFor({ workItemId: 'MER-32A' });
        const artifactPath = handle ? join(handle.root, `${handle.key}.artifacts`, 'marker.md') : '';
        let artifactText = '';
        try { artifactText = readFileSync(artifactPath, 'utf8'); } catch { artifactText = ''; }
        audit.observe({ name: 'live artifact', value: artifactText });
        audit.check({
            name: 'the live engine ran the rendered prompt and saved its marker',
            ok: apiCalls > 0 && artifactText.includes('ORCH-MER-32A'),
            detail: {
                expected: '> 0 api_request · the artifact contains ORCH-MER-32A',
                observed: `${apiCalls} api_request · artifact ${JSON.stringify(artifactText)}`,
            },
        });
    }
    audit.end();

    // ── C: a broken edit is visible, and a valid save resumes ────────────────
    audit.scenario({
        id: 'C', title: 'a broken edit is visible, and a valid save resumes',
        goal: 'a malformed contract keeps the last good config, blocks the tick, and is reported by the operator; a valid save resumes with no restart',
        expect: 'reload() → healthy false, applied null, reasons non-empty · tick outcome validation_error · /state policy.healthy false with reasons · status page says "Policy: failed" · the ring holds workflow_policy:reload_failed · a valid save applies pollIntervalMs and dispatches MER-32B',
        fails: [
            { code: 'half-applied', symptom: 'the scheduler interval changed on the broken edit', hint: 'reload() applies only a healthy, changed mapping' },
            { code: 'invisible', symptom: 'the state page shows no policy block', hint: 'getPolicySnapshot feeds toStateResponse() and formatStatus()' },
            { code: 'dropped-record', symptom: 'the ring has no workflow_policy record', hint: 'workflow_policy: is in the ring default prefixes' },
            { code: 'no-resume', symptom: 'MER-32B never dispatched', hint: 'the same scheduler resumes dispatch after the valid save' },
        ],
        input: { broken: 'invalid front matter', resumed: 'polling.interval_ms 60000' },
    });

    const listening = await orchestration.listen();
    try {
        await writeFile(workflowPath, '---\ntracker: [not-a-map\n---\nbroken');
        const broken = await orchestration.reload();
        await orchestration.scheduler.tick();

        const stateBroken = /** @type {any} */ (await (await fetch(`${listening.url}/api/v1/state`)).json());
        const page = await (await fetch(`${listening.url}/`)).text();
        const policyRecord = all('workflow_policy:reload_failed')[0] ?? null;

        audit.observe({ name: 'reload', value: { healthy: broken.healthy, changed: broken.changed, applied: broken.applied } });
        audit.observe({ name: 'operator policy', value: stateBroken.policy });
        audit.check({
            name: 'a broken edit applies nothing and reports its reasons',
            ok: broken.healthy === false && broken.applied === null && broken.reasons.length > 0
                && orchestration.scheduler.snapshot().pollIntervalMs === 3_600_000,
            detail: {
                expected: 'healthy false · applied null · reasons non-empty · interval unchanged',
                observed: `healthy ${broken.healthy} · applied ${String(broken.applied)} · reasons ${broken.reasons.length} · interval ${orchestration.scheduler.snapshot().pollIntervalMs}`,
            },
        });
        audit.check({
            name: 'the tick is a validation_error, not an idle ok',
            ok: orchestration.scheduler.snapshot().lastOutcome === 'validation_error',
            detail: {
                expected: 'lastOutcome validation_error',
                observed: String(orchestration.scheduler.snapshot().lastOutcome),
            },
        });
        audit.check({
            name: 'the operator state reports the policy health and the reasons',
            ok: stateBroken.policy !== null && stateBroken.policy.healthy === false
                && Array.isArray(stateBroken.policy.reasons) && stateBroken.policy.reasons.length > 0,
            detail: {
                expected: 'policy.healthy false · reasons non-empty',
                observed: `healthy ${String(stateBroken.policy?.healthy)} · reasons ${JSON.stringify(stateBroken.policy?.reasons)}`,
            },
        });
        audit.check({
            name: 'the status page says the policy failed, and the ring kept the record',
            ok: page.includes('Policy: failed') && page.includes(stateBroken.policy.reasons[0])
                && policyRecord !== null && Array.isArray(policyRecord.reasons),
            detail: {
                expected: 'a failed policy line with its first reason, plus a ring record',
                observed: `page ${page.includes('Policy: failed') ? 'has' : 'lacks'} the line · ring record ${policyRecord === null ? 'absent' : 'present'}`,
            },
        });

        await writeFile(workflowPath, contract({ intervalMs: 60_000 }));
        const resumed = await orchestration.reload();
        await orchestration.scheduler.tick();
        await waitFor({ predicate: () => orchestration.scheduler.snapshot().completed.includes('MER-32B') });

        audit.check({
            name: 'a valid save applies the changed interval and dispatches the waiting item',
            ok: resumed.healthy === true
                && Array.isArray(resumed.applied?.changed) && resumed.applied.changed.includes('pollIntervalMs')
                && orchestration.scheduler.snapshot().completed.includes('MER-32B'),
            detail: {
                expected: 'applied changed [pollIntervalMs] · MER-32B completed',
                observed: `updated ${JSON.stringify(resumed.applied?.changed ?? null)} · completed [${orchestration.scheduler.snapshot().completed.join(',')}]`,
            },
        });
        audit.check({
            name: 'the resumed system never restarted',
            ok: orchestration.scheduler.snapshot().started === true && orchestration.scheduler.snapshot().stopped === false,
            detail: {
                expected: 'started true · stopped false',
                observed: `started ${orchestration.scheduler.snapshot().started} · stopped ${orchestration.scheduler.snapshot().stopped}`,
            },
        });
    } finally {
        await orchestration.close();
    }
    audit.end();

    // ── D: stop is one call ──────────────────────────────────────────────────
    audit.scenario({
        id: 'D', title: 'stop is one call',
        goal: 'stop() closes the operator server, drains the scheduler, stops the ring and the policy, and leaves no timer',
        expect: 'stop() → drained true · policy stopped · no armed timer · closing again is a no-op',
        fails: [
            { code: 'policy-left', symptom: 'policy.snapshot().stopped is false', hint: 'stop() stops the policy after the scheduler drains' },
            { code: 'timer-left', symptom: 'the manual clock still holds a timer', hint: 'scheduler.stop() clears the poll timer' },
            { code: 'close-throws', symptom: 'the second close() rejected', hint: 'close() is idempotent' },
        ],
        input: { reason: 'example-done' },
    });

    const counts = await orchestration.stop();
    active = null;
    const snapshotD = orchestration.scheduler.snapshot();
    await orchestration.close();

    audit.observe({ name: 'stop counts', value: counts });
    audit.check({
        name: 'stop drained the work and stopped the policy',
        ok: counts.drained === true && orchestration.policy.snapshot().stopped === true
            && snapshotD.started === true && snapshotD.stopped === true,
        detail: {
            expected: 'drained true · policy stopped · snapshot started+stopped',
            observed: `drained ${counts.drained} · policy stopped ${orchestration.policy.snapshot().stopped} · started ${snapshotD.started} · stopped ${snapshotD.stopped}`,
        },
    });
    audit.check({
        name: 'no timer is left armed and a second close is a no-op',
        ok: timers.size === 0,
        detail: { expected: '0 armed timers', observed: `${timers.size} armed timers` },
    });
    audit.check({
        name: 'the second close() resolves',
        ok: await orchestration.close().then(() => true, () => false),
        detail: { expected: 'close() resolves twice', observed: 'resolved' },
    });
    audit.end();

    if (live !== null && usage !== null) reportUsage({ provider: live.provider, usage });
    log.success({ m: 'Coordination verified: one call, one attempt, one visible block, one stop.' });
}

// The await matters: a truncated log must not exit 0.
try {
    await audit.run(main);
} finally {
    if (active !== null) {
        await active.close().catch(() => {});
        await active.stop().catch(() => {});
    }
    if (dir !== '') await rm(dir, { recursive: true, force: true });
}
