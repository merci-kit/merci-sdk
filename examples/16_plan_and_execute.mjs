// @ts-check
/**
 * Example 16 — Plan → approve → execute with a durable handoff.
 *
 * Two phases over one shared plan/todo store and one on-disk session thread:
 *
 *   A — PLAN (read-only): `.withPlan` swaps the session into the plan agent
 *       (deny-everything rules + `withPlanTools` read-only tools + `plan_exit`)
 *       and `.withAutoContext` renders the workspace plus any AGENTS.md. The
 *       agent writes the plan as todos; `plan_exit` blocks on an approval gate
 *       answered here from stdin (a closed stdin defaults to approve).
 *   B — EXECUTE: a FRESH session — a simulated process restart — restores the
 *       approved conversation from `LocalFileSessionStore`, switches with
 *       `.withExecute`, and writes the artifact with a real `write_file` tool.
 *
 * Durability: `.saveCheckpoint()` after the plan run and `.loadCheckpoint()` in
 * the resumed session — the approved direction survives the process.
 *
 * Public API: `LocalFileSessionStore`, `createContextTools`, `createUserMessage`,
 * `defaultDisplay`, `EVENTS`, `client.session(model).withPlan(...)`, `.withPlanTools`,
 * `.withAutoContext`, `.withSessionStore`, `.saveCheckpoint`, `.loadCheckpoint`,
 * `.withExecute`, `.withTools`, `.withObjective`, `.approvePlanExit`.
 *
 * Run: `node examples/16_plan_and_execute.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
    AGENT_EXECUTE, AGENT_PLAN, EVENTS, LocalFileSessionStore, createPlanStageFollowUp,
    createUserMessage, defaultDisplay, initializeClient, loadCredentials, log,
} from 'merci-sdk';
import { createContextTools } from 'merci-sdk/tools';
import { readlineSafe, reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

const PLAN_GOAL = 'Plan how to write a short operator runbook (markdown, at most 3 sections) for restarting the billing service. Record the plan as tasks and call plan_exit when finalized.';
const EXECUTE_GOAL = 'Write the approved runbook to the file "runbook.md" using the write_file tool, then confirm the path.';
const THREAD_ID = 'example-15-plan';

/** A real writer confined to the workspace: the SDK calls `execute({ args })`. */
/** @param {{root: string}} arg0 */
function writeFileTool({ root }) {
    return {
        name: 'write_file',
        description: `Writes a UTF-8 text file under ${root} and returns the real path.`,
        parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'File path relative to the workspace.' }, content: { type: 'string' } },
            required: ['path', 'content'],
        },
        /** @param {{args: {path: string, content: string}}} arg0 */
        async execute({ args }) {
            const base = resolve(root);
            const target = resolve(base, String(args.path));
            if (target !== base && !target.startsWith(base + sep)) throw new Error(`path escapes the workspace: ${args.path}`);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, String(args.content ?? ''), 'utf8');
            return JSON.stringify({ written: target, bytes: Buffer.byteLength(String(args.content ?? ''), 'utf8') });
        },
    };
}

let failures = 0;
/** @param {{name: string, passed: boolean, detail?: string}} arg0 */
function check({ name, passed, detail }) {
    if (!passed) failures += 1;
    log.check({ name, passed, detail });
}

async function main() {
    const { provider, defaultModel } = resolveExample();
    log.header({ t: `Example 16 — Plan & Execute (${provider})` });

    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    const workspace = await mkdtemp(join(tmpdir(), 'merci-plan-exec-'));
    await writeFile(join(workspace, 'AGENTS.md'), '# House rules\n\n- The runbook must fit on one screen.\n- Prefer boring, reversible steps.\n', 'utf8');
    log.option({ name: 'workspace', value: workspace, source: 'mkdtemp + AGENTS.md (auto-context)' });

    const store = new LocalFileSessionStore({ dir: join(workspace, 'sessions') });
    const todoStore = new Map();
    const planFile = join(workspace, 'plan.todos.json');

    // ── Phase A: read-only plan agent + approval-gated plan_exit ────────────
    log.section({ t: 'A · plan (read-only) → approve' });
    const planSession = client.session(defaultModel)
        .withAutoContext({ options: { root: workspace } })
        .withPlan({ options: { store: todoStore, filePath: planFile, approvalTimeoutMs: 120_000 } })
        .withPlanTools({ tools: createContextTools({ options: { root: workspace } }) })
        .withSessionStore({ store, threadId: THREAD_ID })
        .withObjective({ ctx: PLAN_GOAL });

    const rl = readline.createInterface({ input, output });
    const plan = { requested: false, approved: /** @type {boolean|null} */ (null), path: /** @type {string|null} */ (null) };
    client.on(EVENTS.PLAN.EXIT_REQUESTED, async (/** @type {any} */ { planPath }) => {
        plan.requested = true;
        plan.path = planPath ?? null;
        const answer = await readlineSafe({ rl, prompt: `\nApprove the plan${planPath ? ` (${planPath})` : ''}? [Y/n]: `, fallback: 'y' });
        plan.approved = answer.trim().toLowerCase() !== 'n';
        planSession.approvePlanExit({ approved: plan.approved });
    });
    client.on(EVENTS.PLAN.EXIT_RESOLVED, (/** @type {any} */ { approved, timedOut }) => log.event({ type: 'plan:exit_resolved', payload: { approved, timedOut } }));

    log.user({ m: PLAN_GOAL });
    const planAnswer = String(await planSession.run({ initialInput: PLAN_GOAL, options: { ...defaultDisplay(), maxIterations: 12 } }));
    warnEmptyAnswer({ answer: planAnswer, label: 'the plan phase' });
    await planSession.saveCheckpoint();
    check({ name: 'the plan agent requested approval via plan_exit', passed: plan.requested, detail: plan.path ?? 'plan_exit was never called' });
    check({ name: 'the plan was approved (closed stdin defaults to yes)', passed: plan.approved === true, detail: `approved=${plan.approved}` });

    // The stage reminder is a follow-up, not a hidden prompt: it keeps the agent
    // in the plan persona until the exit gate is answered, then it stops.
    const stageReminder = /** @type {(ctx: { round: number }) => string|null} */ (
        createPlanStageFollowUp({ session: /** @type {any} */ (planSession) })
    );
    const freshReminder = /** @type {(ctx: { round: number }) => string|null} */ (
        createPlanStageFollowUp({ session: /** @type {any} */ (client.session(defaultModel)) })
    );
    log.option({ name: 'personas', value: `${AGENT_PLAN} → ${AGENT_EXECUTE}`, source: 'AGENT_PLAN / AGENT_EXECUTE' });
    log.option({ name: 'stage reminder', value: stageReminder({ round: 0 }) === null ? 'cleared after plan_exit' : 'still armed', source: 'createPlanStageFollowUp({ session })' });
    check({
        name: 'the plan-stage reminder is armed before plan_exit and cleared after it',
        passed: typeof freshReminder({ round: 0 }) === 'string' && stageReminder({ round: 0 }) === null,
        detail: `fresh=${typeof freshReminder({ round: 0 })} · afterExit=${String(stageReminder({ round: 0 }))}`,
    });

    // ── Phase B: process restart — restore the thread and execute ───────────
    log.section({ t: 'B · resume from disk → execute' });
    const execSession = client.session(defaultModel)
        .withAutoContext({ options: { root: workspace } })
        .withTodos({ store: todoStore, options: { filePath: planFile } })
        .withTools({ tools: [writeFileTool({ root: workspace })] })
        .withSessionStore({ store, threadId: THREAD_ID })
        .withExecute({ options: { rules: { task: 'deny' } } });

    const checkpoint = await execSession.loadCheckpoint();
    execSession.withObjective({ ctx: EXECUTE_GOAL });
    const history = Array.isArray(checkpoint?.messages) ? [...checkpoint.messages] : [];
    history.push(createUserMessage({ provider, content: EXECUTE_GOAL }));
    log.option({ name: 'restored history', value: `${history.length} message(s)`, source: 'loadCheckpoint()' });
    check({ name: 'the checkpoint restored the approved plan conversation', passed: history.length > 1, detail: `${history.length} message(s)` });

    if (plan.approved !== false) {
        log.user({ m: EXECUTE_GOAL });
        const execAnswer = String(await execSession.run({ initialInput: history, options: { ...defaultDisplay(), maxIterations: 12 } }));
        warnEmptyAnswer({ answer: execAnswer, label: 'the execute phase' });
    } else {
        log.warn({ m: 'plan was declined — skipping the execute phase.' });
    }

    let runbook = '';
    try { runbook = await readFile(join(workspace, 'runbook.md'), 'utf8'); } catch { /* not written */ }
    if (runbook) log.info({ m: `runbook.md (${runbook.length} chars):\n${log.truncate({ text: runbook, n: 400 })}` });
    check({ name: 'the execute phase wrote runbook.md', passed: runbook.trim().length > 0, detail: runbook ? `${runbook.trim().length} char(s)` : 'file missing or empty' });

    rl.close();
    await rm(workspace, { recursive: true, force: true });
    reportUsage({ provider, usage });
    if (failures > 0) throw new Error(`${failures} check(s) failed`);
    log.success({ m: 'Plan → approval → durable execute handoff verified.' });
}

runMain({ mainFn: main });
