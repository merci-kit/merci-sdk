// @ts-check
/**
 * Example 29 — The workflow contract: one repo-owned file, from config to prompt.
 *
 * A temporary repository owns a single `WORKFLOW.md`. You follow that file
 * through every stage a host needs, in order:
 *
 *   1 — WRITE AND LOAD : `new WorkflowPolicy({ path })` then `start()` resolves the
 *       YAML front matter and the prompt body into one frozen config. `snapshot()`
 *       is the operator view: health, watch state, prompt size, redacted provider.
 *   2 — RENDER         : `renderPrompt({ issue, attempt })` fills the body from
 *       variables, `createPolicyRenderer({ policy })` maps a scheduler attempt onto
 *       the template (1 → first run, N → retry N-1), an unknown variable is a
 *       `PolicyError`, and the parser/loader/renderer work with no policy at all.
 *   3 — MAP            : `policyToSchedulerOptions({ policy })` turns the config into
 *       live scheduler options and preflight; `policyToWorkspaceOptions({ policy })`
 *       yields the workspace strategy and hooks.
 *   4 — BREAK          : an edit with invalid YAML is refused. The last known good
 *       prompt still renders, and both preflight paths name the reason.
 *   5 — RELOAD         : the repaired file is applied, and a real model answers the
 *       newly rendered prompt — the prompt you saw is the prompt that ran.
 *
 * Public API: `WorkflowPolicy`, `createPolicyRenderer`, `parseWorkflowMarkdown`,
 * `loadWorkflowFile`, `renderPromptTemplate`, `policyToSchedulerOptions`,
 * `policyToWorkspaceOptions`, `WORKFLOW_POLICY_REASONS`, `PolicyError`,
 * `MerciEventEmitter`, `EVENTS`.
 *
 * Run: `node examples/29_workflow_contract.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENTS, MerciEventEmitter, PolicyError, initializeClient, loadCredentials, log } from 'merci-sdk';
import {
    WORKFLOW_POLICY_REASONS,
    WorkflowPolicy, createPolicyRenderer, loadWorkflowFile, parseWorkflowMarkdown,
    policyToSchedulerOptions, policyToWorkspaceOptions, renderPromptTemplate,
} from 'merci-sdk/workflow-policy';
import { reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';

/** Lives only in `tracker.provider`; the operator view and the event trail must never show it. */
const SECRET = 'SECRET_workflow_provider_do_not_leak';

/** The issue view the direct renderer calls receive. */
const ISSUE = {
    identifier: 'MER-29',
    labels: ['agent'],
    description: 'Add a repo-owned workflow contract.',
};

/** The scheduler work item `createPolicyRenderer` maps into that issue view. */
const ITEM = {
    id: 'wi-31',
    identifier: 'MER-29',
    title: 'Ship the workflow contract',
    state: 'In Progress',
    url: null,
    lane: 'in progress',
    dispatchable: true,
    description: 'Add a repo-owned workflow contract.',
    priority: 1,
    labels: ['agent'],
};

/** What the repaired template asks the model to answer, exactly. */
const MARKER = 'CONTRACT-MER-29';

/**
 * The file a repository owns: policy front matter, then the prompt body.
 * @param {{root: string}} arg0
 * @returns {string}
 */
function workflowMarkdown({ root }) {
    return [
        '---',
        'tracker:',
        '  kind: linear',
        '  provider:',
        `    project: ${SECRET}`,
        '  required_labels: [agent]',
        '  active_states: ["Todo", "In Progress"]',
        '  terminal_states: ["Done", "Cancelled"]',
        'polling:',
        '  interval_ms: 15000',
        'workspace:',
        `  root: ${root}`,
        'agent:',
        '  max_concurrent_agents: 3',
        '  max_concurrent_agents_by_state:',
        '    "In Progress": 2',
        'hooks:',
        '  after_create: echo workspace-ready',
        'merci:',
        '  workspace:',
        '    strategy: directory',
        '  scheduler:',
        '    max_attempts_per_item: 4',
        '    max_dispatches: 12',
        '  engine:',
        '    kind: agentic',
        '---',
        'You are working on {{ issue.identifier }}.',
        'Labels: {{ issue.labels }}.',
        '{% if attempt %}Retry attempt {{ attempt }} of the pipeline.{% else %}This is the first attempt.{% endif %}',
        '{% if issue.description %}{{ issue.description }}{% else %}No description was provided.{% endif %}',
        '',
    ].join('\n');
}

/**
 * The repaired file: the same front matter, a body the model can answer exactly.
 * @param {{root: string, body: string}} arg0
 * @returns {string}
 */
function liveMarkdown({ root, body }) {
    return `${workflowMarkdown({ root }).split('You are working on')[0] ?? ''}${body}\n`;
}

/**
 * The invalid YAML an edit can leave behind. Its size differs from the valid
 * file, so a plain (non-forced) reload always sees the change.
 * @returns {string}
 */
function brokenMarkdown() {
    return ['---', 'tracker:', '  kind: [linear', '---', 'Broken body.', ''].join('\n');
}

let failures = 0;
/** @param {{name: string, passed: boolean, detail?: string}} arg0 */
function check({ name, passed, detail }) {
    if (!passed) failures += 1;
    log.check({ name, passed, detail });
}

async function main() {
    const { provider, toolModel } = resolveExample();
    log.header({ t: `Example 29 — The workflow contract (${provider})` });

    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });
    let apiCalls = 0;
    client.on('api_request', () => { apiCalls += 1; });

    const dir = await mkdtemp(join(tmpdir(), 'merci-workflow-'));
    const path = join(dir, 'WORKFLOW.md');
    const root = join(dir, 'workspaces');

    /** @type {MerciEventEmitter} */
    const emitter = new MerciEventEmitter();
    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    emitter.onAny((/** @type {unknown} */ envelope) => { events.push(/** @type {Record<string, unknown>} */ (envelope)); });

    const policy = new WorkflowPolicy({ path, watch: false, env: {}, eventEmitter: emitter });

    try {
        await writeFile(path, workflowMarkdown({ root }), 'utf8');
        log.option({ name: 'WORKFLOW.md', value: path, source: 'mkdtemp — removed in finally' });
        log.option({ name: 'watch', value: false, source: 'the host calls reload(); a watcher would call the same path' });
        log.info({ m: 'The file has two halves: YAML front matter that becomes policy, and a body that becomes the prompt. Nothing else in the repo configures this run.' });

        // ── 1 · the file becomes one frozen contract ─────────────────────────
        log.section({ t: '1 · start() — the file becomes one frozen config' });
        await policy.start();

        const config = policy.getConfig();
        if (config === null) throw new Error('the policy resolved no config after start');

        log.list({ title: 'resolved config', items: [
            `tracker ${config.tracker.kind} · active ${config.tracker.activeStates.join(', ')} · terminal ${config.tracker.terminalStates.join(', ')} · labels ${config.tracker.requiredLabels.join(', ')}`,
            `poll ${config.polling.intervalMs}ms · ${config.agent.maxConcurrentAgents} agents · "In Progress" ${config.agent.maxConcurrentAgentsByState['in progress']}`,
            `retry ${config.scheduler.maxAttemptsPerItem} attempts/item · ${config.scheduler.maxDispatches} dispatches · engine ${config.engine.kind}`,
            `workspace ${config.workspace.strategy} at ${config.workspace.root}`,
        ] });

        const snapshot = policy.snapshot();
        const promptInfo = /** @type {{chars: number, hash: string}|null} */ (snapshot.prompt);
        const provider = /** @type {any} */ (snapshot.config).tracker.provider;
        log.option({ name: 'snapshot', value: `healthy ${String(snapshot.healthy)} · watch ${String(snapshot.watch)} · prompt ${promptInfo?.chars ?? 0} chars`, source: 'policy.snapshot()' });
        log.option({ name: 'provider, as the operator sees it', value: JSON.stringify(provider), source: 'snapshot() reports keys, never values' });

        check({
            name: 'start() resolves the file into one frozen, healthy contract',
            passed: Object.isFrozen(config) && Object.isFrozen(config.tracker.activeStates)
                && config.polling.intervalMs === 15_000
                && JSON.stringify(config.tracker.activeStates) === JSON.stringify(['Todo', 'In Progress'])
                && config.agent.maxConcurrentAgents === 3
                && config.agent.maxConcurrentAgentsByState['in progress'] === 2
                && config.scheduler.maxDispatches === 12
                && config.engine.kind === 'agentic'
                && snapshot.healthy === true && snapshot.watch === 'disabled'
                && promptInfo !== null && promptInfo.chars > 0
                && !JSON.stringify(snapshot).includes(SECRET),
            detail: `frozen ${Object.isFrozen(config)} · poll ${config.polling.intervalMs}ms · active ${JSON.stringify(config.tracker.activeStates)} · agents ${config.agent.maxConcurrentAgents} (In Progress ${config.agent.maxConcurrentAgentsByState['in progress']}) · dispatches ${config.scheduler.maxDispatches} · healthy ${String(snapshot.healthy)} · prompt ${promptInfo?.chars ?? 0} chars · provider ${JSON.stringify(provider)}`,
        });

        // ── 2 · the body is a template with variables ────────────────────────
        log.section({ t: '2 · renderPrompt — variables, attempts and strictness' });
        const firstAttempt = policy.renderPrompt({ issue: ISSUE });
        const renderer = createPolicyRenderer({ policy });
        const renderedFirst = renderer({ item: ITEM, attempt: 1 });
        const renderedRetry = renderer({ item: ITEM, attempt: 2 });
        const retryLine = renderedRetry.trim().split('\n').find((line) => line.startsWith('Retry attempt')) ?? '';
        log.user({ m: firstAttempt.trim() });
        log.option({ name: 'attempt 2 line', value: retryLine, source: 'createPolicyRenderer({ policy })({ item, attempt: 2 })' });
        check({
            name: 'the renderer maps attempt 1 to the first run and attempt N to retry N-1',
            passed: renderedFirst === firstAttempt
                && firstAttempt.includes('This is the first attempt.')
                // The renderer passes the RETRY index, not the attempt ordinal:
                // attempt 2 is the first retry, so the template sees `attempt 1`.
                && renderedRetry.includes('Retry attempt 1 of the pipeline.')
                && !renderedRetry.includes('This is the first attempt.'),
            detail: `attempt 1 ${renderedFirst === firstAttempt ? 'identical to renderPrompt(null)' : 'differs from renderPrompt(null)'} · attempt 2 "${retryLine}"`,
        });

        log.info({ m: 'The template is strict on purpose: a variable the issue does not have is an error, never an empty string the model would silently misread.' });
        /** @type {unknown} */
        let renderError = null;
        try { policy.renderPrompt({ issue: {} }); } catch (err) { renderError = err; }
        check({
            name: 'an unknown variable is a PolicyError naming the field',
            passed: renderError instanceof PolicyError && renderError.reason === 'template_render_error:issue.identifier',
            detail: renderError instanceof PolicyError ? `PolicyError ${String(renderError.reason)}` : String(renderError),
        });

        // The parser, loader and renderer are public on purpose: a linter or a
        // doctor command resolves the same contract without constructing a policy.
        const loaded = await loadWorkflowFile({ path, env: {} });
        const parsed = parseWorkflowMarkdown({ markdown: await readFile(path, 'utf8'), path });
        const preview = renderPromptTemplate({ template: parsed.promptTemplate, issue: ISSUE, attempt: 3 });
        const parsedConfig = /** @type {any} */ (parsed.config);
        log.option({ name: 'loadWorkflowFile', value: `${loaded.config.polling.intervalMs}ms poll, no policy object`, source: 'merci-sdk/workflow-policy' });
        log.option({ name: 'parseWorkflowMarkdown + renderPromptTemplate', value: preview.trim().split('\n').find((line) => line.startsWith('Retry attempt')) ?? '', source: 'no policy constructed' });
        check({
            name: 'the loader, parser and renderer resolve the same file without a policy',
            passed: loaded.config.polling.intervalMs === 15_000
                && parsedConfig?.tracker?.kind === 'linear'
                && preview.includes('Retry attempt 3 of the pipeline.')
                && WORKFLOW_POLICY_REASONS.includes('workflow_parse_error'),
            detail: `poll ${loaded.config.polling.intervalMs}ms · kind ${String(parsedConfig?.tracker?.kind)} · attempt 3 rendered ${preview.includes('Retry attempt 3')} · ${WORKFLOW_POLICY_REASONS.length} published reasons`,
        });

        // ── 3 · the contract becomes live scheduler options ──────────────────
        log.section({ t: '3 · policyToSchedulerOptions — states, caps, retry pairs, preflight' });
        const schedulerOptions = policyToSchedulerOptions({ policy });
        const workspaceOptions = policyToWorkspaceOptions({ policy });
        log.list({ title: 'scheduler options', items: [
            `active ${JSON.stringify(schedulerOptions.activeStates)} · terminal ${JSON.stringify(schedulerOptions.terminalStates)} · labels ${JSON.stringify(schedulerOptions.requiredLabels)}`,
            `poll ${schedulerOptions.pollIntervalMs}ms · stall ${schedulerOptions.stallTimeoutMs}ms`,
            `concurrency global ${schedulerOptions.concurrency.global} · byLane ${JSON.stringify(schedulerOptions.concurrency.byLane)}`,
            `retry ${JSON.stringify(schedulerOptions.retry)} · continuation ${JSON.stringify(schedulerOptions.continuation)} · limits ${JSON.stringify(schedulerOptions.limits)}`,
            `preflight ${JSON.stringify(schedulerOptions.preflight())}`,
        ] });
        log.list({ title: 'workspace options', items: [
            `root ${workspaceOptions.root} · strategy ${workspaceOptions.strategy} · baseRef ${workspaceOptions.baseRef} · branchPrefix ${workspaceOptions.branchPrefix}`,
            `afterCreate ${JSON.stringify(workspaceOptions.hooks.afterCreate)} · beforeRun ${String(workspaceOptions.hooks.beforeRun)} · timeout ${workspaceOptions.hooks.timeoutMs}ms`,
        ] });
        check({
            name: 'the mapping carries the states, per-state lanes, retry pairs and the workspace hooks',
            passed: JSON.stringify(schedulerOptions.activeStates) === JSON.stringify(['Todo', 'In Progress'])
                && schedulerOptions.pollIntervalMs === 15_000
                && JSON.stringify(schedulerOptions.concurrency.byLane) === JSON.stringify({ 'in progress': 2 })
                && JSON.stringify(schedulerOptions.retry) === JSON.stringify({ baseMs: 10_000, maxMs: 300_000 })
                && schedulerOptions.limits.maxDispatches === 12
                && JSON.stringify(schedulerOptions.preflight()) === JSON.stringify([])
                && workspaceOptions.strategy === 'directory'
                && !('repoRoot' in workspaceOptions)
                && workspaceOptions.hooks.afterCreate === 'echo workspace-ready',
            detail: `active ${JSON.stringify(schedulerOptions.activeStates)} · byLane ${JSON.stringify(schedulerOptions.concurrency.byLane)} · retry ${JSON.stringify(schedulerOptions.retry)} · limits ${JSON.stringify(schedulerOptions.limits)} · preflight ${JSON.stringify(schedulerOptions.preflight())} · workspace ${workspaceOptions.strategy} · afterCreate ${JSON.stringify(workspaceOptions.hooks.afterCreate)}`,
        });

        // ── 4 · a broken edit keeps the last good prompt ─────────────────────
        log.section({ t: '4 · a broken edit — the last known good contract survives' });
        await writeFile(path, brokenMarkdown(), 'utf8');
        const broken = await policy.reload();
        log.option({ name: 'reload result', value: `changed ${String(broken.changed)} · healthy ${String(broken.healthy)} · ${JSON.stringify(broken.reasons)}`, source: 'policy.reload()' });
        log.info({ m: 'The edit is refused as a whole: the previous config, prompt and mapping stay in effect, and preflight now names the reason a scheduler would refuse new work.' });
        const afterBreak = policy.renderPrompt({ issue: ISSUE });
        check({
            name: 'the invalid edit is refused and the old prompt still renders',
            passed: broken.changed === false && broken.healthy === false
                && broken.reasons.some((reason) => reason.startsWith('workflow_parse_error'))
                && JSON.stringify(policy.preflight()) === JSON.stringify(broken.reasons)
                && JSON.stringify(schedulerOptions.preflight()) === JSON.stringify(broken.reasons)
                && afterBreak === firstAttempt,
            detail: `changed ${String(broken.changed)} · healthy ${String(broken.healthy)} · reasons ${JSON.stringify(broken.reasons)} · prompt ${afterBreak === firstAttempt ? 'unchanged' : 'changed'} · mapped preflight ${JSON.stringify(schedulerOptions.preflight())}`,
        });

        // ── 5 · a repaired edit applies, and the model runs that prompt ──────
        log.section({ t: '5 · the repaired file — reload applies and the model answers it' });
        await writeFile(path, liveMarkdown({ root, body: 'Reply with exactly: CONTRACT-{{ issue.identifier }}' }), 'utf8');
        const repaired = await policy.reload();
        const renderedLive = policy.renderPrompt({ issue: ISSUE });
        log.option({ name: 'reload result', value: `changed ${String(repaired.changed)} · healthy ${String(repaired.healthy)} · ${JSON.stringify(repaired.reasons)}`, source: 'policy.reload()' });
        log.user({ m: renderedLive.trim() });
        check({
            name: 'the repaired edit replaces the stale prompt',
            passed: repaired.changed === true && repaired.healthy === true
                && JSON.stringify(policy.preflight()) === JSON.stringify([])
                && renderedLive !== firstAttempt && renderedLive.includes(MARKER),
            detail: `changed ${String(repaired.changed)} · healthy ${String(repaired.healthy)} · preflight ${JSON.stringify(policy.preflight())} · prompt ${renderedLive.trim()}`,
        });

        const answer = String(await client.session(toolModel).run({
            initialInput: renderedLive,
            options: { maxIterations: 2 },
        }) ?? '');
        warnEmptyAnswer({ answer, label: 'the reloaded prompt' });
        log.assistant({ m: answer });

        const eventNames = events.map((entry) => String(entry.event ?? ''));
        log.list({ title: 'event trail', items: [...new Set(eventNames)] });
        check({
            name: 'the real model answered the rendered prompt and the event trail is complete and clean',
            passed: answer.includes(MARKER) && apiCalls > 0
                && eventNames.includes(EVENTS.WORKFLOW_POLICY.LOADED)
                && eventNames.includes(EVENTS.WORKFLOW_POLICY.RELOADED)
                && eventNames.includes(EVENTS.WORKFLOW_POLICY.RELOAD_FAILED)
                && !JSON.stringify(events).includes(SECRET),
            detail: `${apiCalls} api_request · answer ${log.truncate({ text: answer.trim(), n: 80 })} · ${eventNames.length} events · ${[...new Set(eventNames)].join(', ')}`,
        });
    } finally {
        policy.stop();
        await rm(dir, { recursive: true, force: true });
    }

    reportUsage({ provider, usage });
    if (failures > 0) throw new Error(`${failures} check(s) failed`);
    log.success({ m: 'Workflow contract: written, loaded, rendered, mapped, refused, reloaded and answered.' });
}

runMain({ mainFn: main });
