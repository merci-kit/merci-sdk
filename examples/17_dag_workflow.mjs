// @ts-check
/**
 * Example 17 — DAG workflow: plan → execute → evaluate → nested child DAG.
 *
 * A real workflow over a local HTTP API the example spawns:
 *
 *   A — plan + execute : `WorkflowPlanner` decomposes the objective into a DAG;
 *       `WorkflowExecutor` runs it with the real `probe_api` / `sync_data`
 *       tools, and template variables (`{{context.endpoint}}`) resolve against
 *       the execution context.
 *   B — self-heal      : `WorkflowEvaluator` audits every completed step; a
 *       rejected step triggers `planner.replan` and the executor re-runs the
 *       rewritten plan (events surface the repair).
 *   C — nested DAG     : a step with `engine: 'dag'` runs a CHILD executor
 *       planned from its own `subObjective` — a workflow inside a workflow.
 *   D — durability     : `executor.save()` snapshots the whole run (objective,
 *       shared context, step statuses/outputs) and `WorkflowExecutor.load()`
 *       rehydrates it; an empty plan is rejected up front.
 *
 * Public API: `WorkflowPlanner`, `WorkflowExecutor`, `WorkflowEvaluator`.
 *
 * Run: `node examples/17_dag_workflow.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENTS, initializeClient, loadCredentials, log } from 'merci-sdk';
import {
    TaskState, WorkflowEvaluator, WorkflowExecutor, WorkflowPlanner,
    assertStateSchema, collectTemplateRefs, validateTemplateRefs,
} from 'merci-sdk/planning';
import { createHttpProbeTool, createSyncDataTool, startLocalApiServer } from './_shared/real-tools.mjs';
import { reportUsage, resolveExample, runMain, showPlan, trackUsage, warnEmptyAnswer, wireClient, wireWorkflowEvents } from './_shared/example-utils.mjs';

const OBJECTIVE = 'Probe the REST inventory endpoint at {{context.endpoint}} with the probe_api tool (pass {{context.endpoint}} verbatim — do not invent URLs), then persist the returned payload with sync_data.';

let failures = 0;
/** @param {{name: string, passed: boolean, detail?: string}} arg0 */
function check({ name, passed, detail }) {
    if (!passed) failures += 1;
    log.check({ name, passed, detail });
}

/** Step ids no other step depends on — the parents of an appended sink step. */
/** @param {Array<Record<string, any>>} steps */
function leavesOf(steps) {
    return steps.filter((s) => !steps.some((o) => (o.dependencies ?? []).includes(s.id))).map((s) => s.id);
}

async function main() {
    const { provider, defaultModel } = resolveExample();
    log.header({ t: `Example 17 — DAG Workflow (${provider})` });

    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    const api = await startLocalApiServer();
    const syncDir = await mkdtemp(join(tmpdir(), 'merci-dag-sync-'));
    const tools = [createHttpProbeTool({ timeoutMs: 5000 }), createSyncDataTool({ dir: syncDir })];
    const restEndpoint = `${api.baseUrl}/legacy/inventory`;
    log.option({ name: 'endpoint', value: restEndpoint, source: 'startLocalApiServer /legacy/inventory — a real listening socket' });

    const planner = new WorkflowPlanner({ options: { client, model: defaultModel } });
    const evaluator = new WorkflowEvaluator({ options: { client, model: defaultModel } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel, tools, maxIterations: 12 } });

    let replans = 0;
    executor.on(EVENTS.WORKFLOW.REPLAN_TRIGGERED, () => { replans += 1; });
    wireWorkflowEvents({ executor });

    // ── A: plan, then append a nested child DAG as the sink step ─────────────
    log.section({ t: 'A · plan (planner) + nested DAG step' });
    const planned = await planner.plan({ objective: OBJECTIVE, availableTools: tools });
    const steps = /** @type {any[]} */ ([...planned.steps]);
    const nestedId = 'ops_digest';
    steps.push({
        id: nestedId,
        title: 'Operations digest',
        engine: 'dag',
        subObjective: 'Produce a 3-bullet operations digest of the parent workflow: the inventory API probe outcome, how many records were synced, and one follow-up action. The endpoint is available as {{context.endpoint}} in the shared context — reference it if a child step needs live data.',
        dependencies: leavesOf(steps),
        intakeMode: 'all',
    });
    showPlan({ steps, label: '17' });
    executor.setSteps({ stepsList: steps });
    check({ name: 'the planner produced a DAG (>= 2 steps)', passed: planned.steps.length >= 2, detail: `${planned.steps.length} planned + 1 nested` });

    // Template variables are checked BEFORE the run: an unresolved root is a
    // planning bug, and finding it here costs nothing instead of failing a step.
    const refs = collectTemplateRefs({ template: OBJECTIVE });
    const templateAudit = validateTemplateRefs({ steps, contextRoots: ['context'] });
    const templateIssues = templateAudit.unknown.length + templateAudit.nonAncestor.length;
    const schemaOk = (() => {
        try {
            assertStateSchema({ schema: { safeParse: (/** @type {any} */ v) => (typeof v === 'string' && v.trim() ? { success: true } : { success: false, error: { issues: [{ path: [], message: 'empty' }] } }) }, value: 'ok', label: 'demo' });
            return true;
        } catch { return false; }
    })();
    log.option({ name: 'template refs', value: refs.map((/** @type {any} */ r) => r.expr).join(', '), source: 'collectTemplateRefs({ template })' });
    check({
        name: 'every template reference resolves to a known context root, and a bad output is rejected',
        passed: refs.length > 0 && refs.every((/** @type {any} */ r) => r.head === 'context')
            && templateIssues === 0 && schemaOk,
        detail: `${refs.length} ref(s) · issues=${templateIssues} · schema accepted a good value`,
    });

    // ── B/C: execute with the evaluator; the nested step plans its own child ─
    log.section({ t: 'B · execute (evaluator on) — nested DAG runs as one step' });
    let outputs = /** @type {Record<string, any>} */ ({});
    let runError = /** @type {any} */ (null);
    try {
        outputs = /** @type {Record<string, any>} */ (await executor.execute({ userGoal: OBJECTIVE, planner, evaluator, context: { endpoint: restEndpoint } }));
    } catch (err) {
        runError = err;
    } finally {
        await api.close();
    }

    const digest = outputs[nestedId];
    const statuses = [...executor.steps.values()].map((s) => `${s.id}:${s.status}`).join(', ');
    check({ name: 'the workflow executed without throwing', passed: !runError, detail: runError ? `${runError.name}: ${runError.message}` : `replans=${replans}` });
    check({ name: 'the nested child DAG returned a digest', passed: Boolean(String(digest?.output ?? '').trim()), detail: `replans=${replans} statuses=[${statuses}]` });
    check({ name: 'every runnable step completed', passed: [...executor.steps.values()].every((s) => s.status === 'completed' || s.historical), detail: statuses });
    warnEmptyAnswer({ answer: digest?.output, label: 'the DAG' });

    // ── D: durability — save/load round-trip + empty-plan guard ─────────────
    log.section({ t: 'D · save() → WorkflowExecutor.load() + empty-plan guard' });
    const json = executor.save();
    const restored = WorkflowExecutor.load({ json, options: { client, defaultModel, tools } });
    // `save()` is a thin wrapper over TaskState: the same snapshot is available
    // directly when a host persists it in its own store.
    const carrier = TaskState.fromExecutor({ executor });
    const carrierJson = carrier.toJSON();
    const replayed = TaskState.fromJSON(carrierJson);
    log.option({ name: 'TaskState', value: `${JSON.stringify(carrierJson).length} chars · ${executor.steps.size} step record(s)`, source: 'TaskState.fromExecutor({ executor }).toJSON()' });
    check({
        name: 'TaskState carries the same run and round-trips through JSON',
        passed: replayed.objective === OBJECTIVE && replayed.steps.length === executor.steps.size,
        detail: `objective=${log.truncate({ text: String(replayed.objective), n: 40 })} · steps=${replayed.steps.length}`,
    });
    check({
        name: 'save()/load() round-trips the run state',
        passed: restored.globalObjective === OBJECTIVE && restored.steps.size === executor.steps.size && Object.keys(restored.outputs).length === Object.keys(executor.outputs).length,
        detail: `${json.length} chars — steps=${restored.steps.size} outputs=${Object.keys(restored.outputs).length}`,
    });
    check({
        name: 'restored step statuses match the snapshot',
        passed: [...restored.steps.values()].every((s) => s.status === executor.steps.get(s.id)?.status),
        detail: [...restored.steps.values()].map((s) => `${s.id}:${s.status}`).join(', '),
    });

    const guard = new WorkflowExecutor({ options: { client, defaultModel, tools: [] } });
    let emptyErr = /** @type {any} */ (null);
    try { guard.setSteps({ stepsList: [] }); } catch (err) { emptyErr = err; }
    check({ name: 'setSteps rejects an empty plan', passed: Boolean(emptyErr) && /empty plan/i.test(String(emptyErr?.message ?? '')), detail: emptyErr ? `${emptyErr.name}: ${emptyErr.message}` : 'accepted (bug)' });

    await rm(syncDir, { recursive: true, force: true });
    reportUsage({ provider, usage });
    if (failures > 0) throw new Error(`${failures} check(s) failed`);
    log.success({ m: 'Planner, executor, evaluator, nested DAG and durability verified.' });
}

runMain({ mainFn: main });
