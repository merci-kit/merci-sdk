// @ts-check
/**
 * Example 29 — The workflow contract.
 *
 * A temp `WORKFLOW.md` is written under `mkdtemp`, a `watch: false` policy
 * loads it, and the example never leaves the process. Live, two edits of the
 * same file render two different prompts and a real model answers each; the
 * deterministic audit still proves the config, rendering, mapping and reload.
 *
 *   A — load and the resolved config  : `start()` resolves the file into one
 *       frozen config, and `snapshot()` reports a healthy, watch-disabled
 *       policy with a non-empty prompt.
 *   B — strict rendering              : the first attempt takes the `else`
 *       branch, the mapped first retry (index 1) takes the `if` branch, an
 *       unknown variable throws, and a filter is a parse error at load.
 *   L — the live prompts              : prompt A is rendered, run on the real
 *       model, then reloaded as prompt B and run again.
 *   C — the mapping                   : `policyToSchedulerOptions` yields the
 *       full pairs, the states, the per-state lanes and the dispatch cap;
 *       `policyToWorkspaceOptions` yields the directory strategy and hooks.
 *   D — last known good               : a broken edit keeps the old prompt and
 *       blocks preflight, a fixed edit swaps it, and `stop()` reports stopped.
 *
 * Public API: `WorkflowPolicy`, `createPolicyRenderer`,
 * `policyToSchedulerOptions`, `policyToWorkspaceOptions`, `PolicyError`,
 * `MerciEventEmitter`.
 *
 * Run: `node test/examples/29_workflow_contract.mjs` (live) · `node test/examples/29_workflow_contract.mjs --offline` (deterministic)
 * Needs: `BACKEND` + provider credentials in `secret.env` for the live prompts;
 *        `--offline` needs none.
 *
 * @version 0.12.0
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENTS, MerciEventEmitter, PolicyError, initializeClient, loadCredentials, log } from 'merci-sdk';
import {
    WORKFLOW_POLICY_DEFAULTS, WORKFLOW_POLICY_REASONS, WORKFLOW_POLICY_WARNINGS,
    WorkflowPolicy, createPolicyRenderer, loadWorkflowFile, parseWorkflowMarkdown,
    policyToSchedulerOptions, policyToWorkspaceOptions, renderPromptTemplate,
} from 'merci-sdk/workflow-policy';
import { createAudit } from '../../examples/_shared/example-audit.mjs';
import { reportUsage, resolveExample, trackUsage, wireClient } from '../../examples/_shared/example-utils.mjs';

const OFFLINE = process.argv.includes('--offline');
const live = OFFLINE ? null : resolveExample();

const audit = createAudit({
    metaUrl: import.meta.url,
    id: 'audit/29_workflow_contract',
    offline: OFFLINE,
    provider: live?.provider ?? null,
    models: live ? live.toolModel : null,
    title: 'Example 29 — The workflow contract',
});

/** Text that lives only in a `tracker.provider` value; it must never be emitted or shown. */
const SECRET = 'SECRET_workflow_provider_do_not_leak';

/** The issue view the direct renderer calls receive. */
const ISSUE = {
    identifier: 'MER-31',
    labels: ['agent'],
    description: 'Add a repo-owned workflow contract.',
};

/**
 * The scheduler `WorkItem` the renderer maps into the issue view. Only the
 * fields the mapping reads are set, so the example shows the boundary.
 * @type {Record<string, unknown>}
 */
const ITEM = {
    id: 'wi-31',
    identifier: 'MER-31',
    title: 'Ship the workflow contract',
    state: 'In Progress',
    url: null,
    lane: 'in progress',
    dispatchable: true,
    description: 'Add a repo-owned workflow contract.',
    priority: 1,
    labels: ['agent'],
};

/**
 * The `WORKFLOW.md` content: every schema section the example asserts.
 * @param {{root: string, trailer?: string}} arg0
 * @returns {string}
 */
function workflowMarkdown({ root, trailer = '' }) {
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
    ].join('\n') + trailer;
}

/**
 * The live `WORKFLOW.md`: the same front matter, one exact-answer body.
 * @param {{root: string, body: string}} arg0
 * @returns {string}
 */
function liveMarkdown({ root, body }) {
    const front = workflowMarkdown({ root }).split('You are working on')[0] ?? '';
    return `${front}${body}\n`;
}

/**
 * The invalid YAML used to prove the last-known-good path. Its size differs
 * from the valid file, so a plain (non-forced) reload always sees the change.
 * @returns {string}
 */
function brokenMarkdown() {
    return ['---', 'tracker:', '  kind: [linear', '---', 'Broken body.', ''].join('\n');
}

/**
 * The `template_parse_error` file: the subset has no filters, so `| upcase`
 * must invalidate the load.
 * @returns {string}
 */
function filterMarkdown() {
    return ['---', 'tracker:', '  kind: linear', '---', 'Fix {{ issue.identifier | upcase }}.', ''].join('\n');
}

/**
 * One event as the recorder keeps it: the event name and the full envelope.
 * @typedef {{event: string, envelope: Record<string, unknown>}} RecordedEvent
 */

async function main() {
    log.option({ name: 'file', value: 'a temp WORKFLOW.md', source: 'mkdtemp — removed in finally' });
    log.option({ name: 'watch', value: 'false', source: 'the watcher is not armed; reload is explicit' });

    /** @type {Awaited<ReturnType<typeof initializeClient>>['client']|null} */
    let client = null;
    /** @type {ReturnType<typeof trackUsage>|null} */
    let usage = null;
    let apiCalls = 0;
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

    const dir = await mkdtemp(join(tmpdir(), 'merci-workflow-29-'));
    const path = join(dir, 'WORKFLOW.md');
    const badPath = join(dir, 'WORKFLOW.bad.md');
    const root = join(dir, 'workspaces');

    /** @type {MerciEventEmitter} */
    const emitter = new MerciEventEmitter();
    /** @type {Array<RecordedEvent>} */
    const events = [];
    emitter.onAny((/** @type {unknown} */ envelope) => {
        const record = /** @type {Record<string, unknown>} */ (envelope);
        events.push({ event: String(record.event ?? ''), envelope: record });
    });

    const policy = new WorkflowPolicy({ path, watch: false, env: {}, eventEmitter: emitter });

    try {
        await writeFile(path, workflowMarkdown({ root }));
        await policy.start();

        // ── A: load and the resolved config ─────────────────────────────────
        audit.scenario({
            id: 'A', title: 'load and the resolved config',
            goal: 'start() resolves the temp WORKFLOW.md into one frozen config, and snapshot() reports a healthy, watch-disabled policy',
            expect: 'getConfig() deep-frozen · interval_ms 15000 · active ["Todo","In Progress"] · terminal ["Done","Cancelled"] · labels ["agent"] · caps 3 / {"in progress":2} · max_dispatches 12 · engine agentic · snapshot healthy, watch disabled, prompt.chars > 0',
            fails: [
                { code: 'mutable-config', symptom: 'the config or one of its arrays is not frozen', hint: 'resolveWorkflowConfig deep-freezes the result' },
                { code: 'defaults', symptom: 'a file value did not reach the resolved config', hint: 'the front matter key is snake_case; the resolved field is camelCase' },
                { code: 'not-healthy', symptom: 'snapshot().healthy is false after a clean start', hint: 'a missing env ref or a template parse error fails the load' },
            ],
            input: { path: 'WORKFLOW.md', watch: false, env: {} },
        });

        const config = policy.getConfig();
        if (config === null) throw new Error('policy did not resolve a config after start');

        audit.observe({ name: 'resolved config', value: {
            intervalMs: config.polling.intervalMs,
            activeStates: config.tracker.activeStates,
            terminalStates: config.tracker.terminalStates,
            requiredLabels: config.tracker.requiredLabels,
            maxConcurrentAgents: config.agent.maxConcurrentAgents,
            byState: config.agent.maxConcurrentAgentsByState,
            maxDispatches: config.scheduler.maxDispatches,
            engine: config.engine.kind,
        } });

        audit.check({
            name: 'getConfig() is deep-frozen at every level the example reads',
            ok: Object.isFrozen(config)
                && Object.isFrozen(config.tracker)
                && Object.isFrozen(config.tracker.activeStates)
                && Object.isFrozen(config.agent.maxConcurrentAgentsByState),
            detail: {
                expected: 'config, tracker, activeStates and byState frozen',
                observed: `${Object.isFrozen(config)}/${Object.isFrozen(config.tracker)}/${Object.isFrozen(config.tracker.activeStates)}/${Object.isFrozen(config.agent.maxConcurrentAgentsByState)}`,
            },
        });
        audit.check({
            name: 'the file values reach the resolved config unchanged',
            ok: config.polling.intervalMs === 15_000
                && JSON.stringify(config.tracker.activeStates) === JSON.stringify(['Todo', 'In Progress'])
                && JSON.stringify(config.tracker.terminalStates) === JSON.stringify(['Done', 'Cancelled'])
                && JSON.stringify(config.tracker.requiredLabels) === JSON.stringify(['agent'])
                && config.agent.maxConcurrentAgents === 3
                && config.agent.maxConcurrentAgentsByState['in progress'] === 2
                && config.scheduler.maxAttemptsPerItem === 4
                && config.scheduler.maxDispatches === 12
                && config.engine.kind === 'agentic',
            detail: {
                expected: '15000 · [Todo, In Progress] · [Done, Cancelled] · [agent] · 3 · {"in progress":2} · 4 · 12 · agentic',
                observed: `${config.polling.intervalMs} · ${JSON.stringify(config.tracker.activeStates)} · ${JSON.stringify(config.tracker.terminalStates)} · ${JSON.stringify(config.tracker.requiredLabels)} · ${config.agent.maxConcurrentAgents} · ${JSON.stringify(config.agent.maxConcurrentAgentsByState)} · ${config.scheduler.maxAttemptsPerItem} · ${config.scheduler.maxDispatches} · ${config.engine.kind}`,
            },
        });

        // The parser, the loader and the renderer are public on purpose: a host
        // can resolve the contract without constructing a policy (a linter, a
        // CLI, a doctor command), using the same rules the policy uses.
        const loaded = await loadWorkflowFile({ path, env: {} });
        const parsed = parseWorkflowMarkdown({ markdown: await readFile(path, 'utf8'), path });
        const rendered = renderPromptTemplate({
            template: parsed.promptTemplate,
            issue: { identifier: 'MER-29', title: 'A rendered issue', state: 'Todo', labels: ['agent'], description: 'Body.' },
            attempt: 2,
        });
        audit.observe({ name: 'primitives', value: { intervalMs: loaded.config.polling.intervalMs, rendered: rendered.slice(0, 64) } });
        audit.check({
            name: 'the parser, the loader and the renderer work without a policy',
            ok: loaded.config.polling.intervalMs === 15_000
                && (/** @type {any} */ (parsed.config)).tracker?.kind === 'linear'
                && rendered.includes('MER-29') && rendered.includes('Retry attempt 2')
                && WORKFLOW_POLICY_DEFAULTS.maxFileBytes === 1_048_576
                && WORKFLOW_POLICY_REASONS.includes('workflow_parse_error')
                && WORKFLOW_POLICY_WARNINGS.includes('unknown_key'),
            detail: {
                expected: 'interval 15000 · kind linear · MER-29 and "Retry attempt 2" rendered · defaults/reasons/warnings published',
                observed: `${loaded.config.polling.intervalMs} · ${String(/** @type {any} */ (parsed.config).tracker?.kind)} · rendered ${rendered.includes('MER-29')}/${rendered.includes('Retry attempt 2')} · defaults ${WORKFLOW_POLICY_DEFAULTS.maxFileBytes} · reasons ${WORKFLOW_POLICY_REASONS.length} · warnings ${WORKFLOW_POLICY_WARNINGS.length}`,
            },
        });

        const started = policy.snapshot();
        audit.observe({ name: 'snapshot', value: {
            healthy: started.healthy,
            watch: started.watch,
            prompt: started.prompt,
            provider: /** @type {Record<string, unknown>} */ (/** @type {Record<string, unknown>} */ (started.config).tracker).provider,
        } });
        audit.check({
            name: 'snapshot() is healthy, watch-disabled and has a non-empty prompt',
            ok: started.healthy === true && started.watch === 'disabled' && started.started === true && started.stopped === false
                && started.prompt !== null && /** @type {{chars: number}} */ (started.prompt).chars > 0,
            detail: {
                expected: 'healthy true · watch disabled · started true · stopped false · prompt.chars > 0',
                observed: `healthy ${String(started.healthy)} · watch ${String(started.watch)} · started ${String(started.started)} · stopped ${String(started.stopped)} · prompt ${JSON.stringify(started.prompt)}`,
            },
        });
        audit.end();

        // ── B: strict rendering ──────────────────────────────────────────────
        audit.scenario({
            id: 'B', title: 'strict rendering',
            goal: 'the first attempt takes the else branch, the mapped first retry (index 1) takes the if branch, and a bad template fails at load',
            expect: 'renderPrompt(null) has the first-attempt text · createPolicyRenderer({attempt:1}) is identical · ({attempt:2}) says "Retry attempt 1" · an unknown variable throws PolicyError · a | upcase filter makes start() reject with template_parse_error',
            fails: [
                { code: 'wrong-branch', symptom: 'both attempts rendered the same branch', hint: 'the scheduler attempt is 1-based; the renderer maps 1 to null and 2 to retry index 1' },
                { code: 'silent-unresolved', symptom: 'an unknown variable rendered empty instead of throwing', hint: 'this template is strict, unlike the DAG interpolator' },
                { code: 'lenient-load', symptom: 'a filter template started and rendered', hint: 'filters are a parse error, so the reload is rejected' },
            ],
            input: { issue: 'MER-31', attempts: [1, 2], filter: '| upcase' },
        });

        const firstAttempt = policy.renderPrompt({ issue: ISSUE, attempt: null });
        const render = createPolicyRenderer({ policy });
        const renderedFirst = render({ item: ITEM, attempt: 1 });
        const renderedRetry = render({ item: ITEM, attempt: 2 });
        audit.observe({ name: 'first attempt', value: firstAttempt });
        audit.observe({ name: 'retry attempt', value: renderedRetry });

        audit.check({
            name: 'the first attempt takes the else branch and renders the issue',
            ok: firstAttempt.includes('You are working on MER-31.')
                && firstAttempt.includes('Labels: agent.')
                && firstAttempt.includes('This is the first attempt.')
                && firstAttempt.includes('Add a repo-owned workflow contract.')
                && !firstAttempt.includes('Retry attempt'),
            detail: {
                expected: 'MER-31 · labels agent · "This is the first attempt." · the description',
                observed: firstAttempt,
            },
        });
        audit.check({
            name: 'createPolicyRenderer maps attempt 1 to the first attempt and attempt 2 to retry index 1',
            ok: renderedFirst === firstAttempt
                && renderedRetry.includes('Retry attempt 1 of the pipeline.')
                && !renderedRetry.includes('This is the first attempt.'),
            detail: {
                expected: 'attempt 1 identical to renderPrompt(null) · attempt 2 says "Retry attempt 1"',
                observed: `attempt 1 ${renderedFirst === firstAttempt ? 'identical' : 'differs'} · attempt 2 ${renderedRetry.includes('Retry attempt 1 of the pipeline.') ? 'retry branch' : 'wrong branch'}`,
            },
        });

        /** @type {unknown} */
        let renderError = null;
        try { policy.renderPrompt({ issue: {} }); } catch (err) { renderError = err; }
        audit.check({
            name: 'an unknown variable throws a PolicyError',
            ok: renderError instanceof PolicyError
                && renderError.reason === 'template_render_error:issue.identifier',
            detail: {
                expected: 'PolicyError reason template_render_error:issue.identifier',
                observed: renderError instanceof PolicyError
                    ? `PolicyError reason ${String(renderError.reason)}`
                    : String(renderError),
            },
        });

        await writeFile(badPath, filterMarkdown());
        const badPolicy = new WorkflowPolicy({ path: badPath, watch: false, env: {} });
        /** @type {unknown} */
        let loadError = null;
        try { await badPolicy.start(); } catch (err) { loadError = err; }
        audit.check({
            name: 'a | upcase filter is a parse error at load, not a render surprise',
            ok: loadError instanceof PolicyError
                && String(loadError.reason).startsWith('template_parse_error:unsupported_filter'),
            detail: {
                expected: 'PolicyError reason template_parse_error:unsupported_filter',
                observed: loadError instanceof PolicyError
                    ? `PolicyError reason ${String(loadError.reason)}`
                    : String(loadError),
            },
        });
        audit.end();

        // ── L: the live prompts ──────────────────────────────────────────────
        if (client !== null && live !== null) {
            audit.scenario({
                id: 'L', title: 'the live prompts',
                goal: 'the same file renders prompt A, a real model answers it, a reload swaps to prompt B and the model answers that too',
                expect: 'render A contains POLICY-A-MER-31 · the answer contains it · reload B healthy · render B differs and contains POLICY-B-MER-31 · the answer contains it · >= 2 api_request · snapshot healthy across the reload',
                fails: [
                    { code: 'no-render', symptom: 'the rendered prompt does not carry its marker', hint: 'the template body IS the prompt; check liveMarkdown' },
                    { code: 'stale-reload', symptom: 'prompt B still renders prompt A', hint: 'the file must change before reload()' },
                    { code: 'wrong-answer', symptom: 'the model answer does not carry the marker', hint: 'the model must reply with the exact line; do not weaken the check' },
                ],
                input: { identifier: 'MER-31', model: live.toolModel, bodies: ['POLICY-A', 'POLICY-B'] },
            });
            const liveRender = createPolicyRenderer({ policy });
            try {
                await writeFile(path, liveMarkdown({
                    root,
                    body: 'Reply with exactly: POLICY-A-{{ issue.identifier }}',
                }));
                const reloadA = await policy.reload();
                const renderedA = liveRender({ item: ITEM, attempt: null });
                const answerA = String(await client.session(live.toolModel).run({
                    initialInput: renderedA,
                    options: { maxIterations: 2 },
                }) ?? '');
                const healthyBefore = policy.snapshot().healthy;

                await writeFile(path, liveMarkdown({
                    root,
                    body: 'Reply with exactly: POLICY-B-{{ issue.identifier }}',
                }));
                const reloadB = await policy.reload();
                const renderedB = liveRender({ item: ITEM, attempt: null });
                const answerB = String(await client.session(live.toolModel).run({
                    initialInput: renderedB,
                    options: { maxIterations: 2 },
                }) ?? '');
                const healthyAfter = policy.snapshot().healthy;

                audit.observe({ name: 'prompt A', value: renderedA });
                audit.observe({ name: 'answer A', value: answerA });
                audit.observe({ name: 'prompt B', value: renderedB });
                audit.observe({ name: 'answer B', value: answerB });
                audit.check({
                    name: 'reload A is healthy and renders the A marker',
                    ok: reloadA.healthy === true && renderedA.includes('POLICY-A-MER-31'),
                    detail: { expected: 'healthy · POLICY-A-MER-31', observed: `healthy ${String(reloadA.healthy)} · ${renderedA}` },
                });
                audit.check({
                    name: 'the live model answered prompt A with its marker',
                    ok: answerA.includes('POLICY-A-MER-31'),
                    detail: { expected: 'the answer contains POLICY-A-MER-31', observed: answerA },
                });
                audit.check({
                    name: 'reload B swaps the prompt, stays healthy and differs from A',
                    ok: reloadB.healthy === true && healthyBefore === true && healthyAfter === true
                        && renderedB !== renderedA && renderedB.includes('POLICY-B-MER-31'),
                    detail: {
                        expected: 'healthy before/after · B differs from A · POLICY-B-MER-31',
                        observed: `healthy ${String(healthyBefore)}/${String(reloadB.healthy)}/${String(healthyAfter)} · differs ${renderedB !== renderedA} · ${renderedB}`,
                    },
                });
                audit.check({
                    name: 'the live model answered prompt B with its marker after >= 2 vendor calls',
                    ok: apiCalls >= 2 && answerB.includes('POLICY-B-MER-31'),
                    detail: {
                        expected: '>= 2 api_request · the answer contains POLICY-B-MER-31',
                        observed: `${apiCalls} api_request · ${answerB}`,
                    },
                });
            } finally {
                // Restore the deterministic template so D's last-known-good prompt is exact.
                await writeFile(path, workflowMarkdown({ root }));
                await policy.reload();
            }
            audit.end();
        }

        // ── C: the mapping ───────────────────────────────────────────────────
        audit.scenario({
            id: 'C', title: 'the mapping',
            goal: 'the resolved policy maps to the scheduler options and the construction-bound workspace options',
            expect: 'full retry/continuation pairs · states and labels · byLane {"in progress":2} · limits.maxDispatches 12 · preflight [] · workspace directory with no repoRoot · hooks afterCreate and timeout',
            fails: [
                { code: 'partial-pair', symptom: 'a retry or continuation field is missing', hint: 'applyConfig replaces the whole sub-object, so the pair is full' },
                { code: 'lost-lane', symptom: 'byLane is empty or has a default state', hint: 'the per-state map is lowercased from the file' },
                { code: 'repo-root', symptom: 'repoRoot appeared for the directory strategy', hint: 'repoRoot is emitted only when the policy set one' },
            ],
            input: { policy: 'started, healthy' },
        });

        const schedulerOptions = policyToSchedulerOptions({ policy });
        const workspaceOptions = policyToWorkspaceOptions({ policy });
        audit.observe({ name: 'scheduler options', value: schedulerOptions });
        audit.observe({ name: 'workspace options', value: workspaceOptions });

        audit.check({
            name: 'the scheduler mapping yields the states, labels, poll interval and the full pairs',
            ok: JSON.stringify(schedulerOptions.activeStates) === JSON.stringify(['Todo', 'In Progress'])
                && JSON.stringify(schedulerOptions.terminalStates) === JSON.stringify(['Done', 'Cancelled'])
                && JSON.stringify(schedulerOptions.requiredLabels) === JSON.stringify(['agent'])
                && schedulerOptions.pollIntervalMs === 15_000
                && schedulerOptions.stallTimeoutMs === 900_000
                && schedulerOptions.concurrency.global === 3
                && JSON.stringify(schedulerOptions.retry) === JSON.stringify({ baseMs: 10_000, maxMs: 300_000 })
                && JSON.stringify(schedulerOptions.continuation) === JSON.stringify({ delayMs: 1_000, max: 3 }),
            detail: {
                expected: '["Todo","In Progress"] · ["Done","Cancelled"] · ["agent"] · 15000 · 900000 · global 3 · retry 10000/300000 · continuation 1000/3',
                observed: `${JSON.stringify(schedulerOptions.activeStates)} · ${JSON.stringify(schedulerOptions.terminalStates)} · ${JSON.stringify(schedulerOptions.requiredLabels)} · ${schedulerOptions.pollIntervalMs} · ${schedulerOptions.stallTimeoutMs} · global ${schedulerOptions.concurrency.global} · retry ${JSON.stringify(schedulerOptions.retry)} · continuation ${JSON.stringify(schedulerOptions.continuation)}`,
            },
        });
        audit.check({
            name: 'byLane comes from the per-state caps and the dispatch cap rides in limits',
            ok: JSON.stringify(schedulerOptions.concurrency.byLane) === JSON.stringify({ 'in progress': 2 })
                && schedulerOptions.limits.maxAttemptsPerItem === 4
                && schedulerOptions.limits.maxDispatches === 12,
            detail: {
                expected: 'byLane {"in progress":2} · limits 4/12',
                observed: `byLane ${JSON.stringify(schedulerOptions.concurrency.byLane)} · limits ${schedulerOptions.limits.maxAttemptsPerItem}/${schedulerOptions.limits.maxDispatches}`,
            },
        });
        audit.check({
            name: 'the mapped preflight is live and reports no blockers',
            ok: JSON.stringify(schedulerOptions.preflight()) === JSON.stringify([]),
            detail: {
                expected: '[]',
                observed: JSON.stringify(schedulerOptions.preflight()),
            },
        });
        audit.check({
            name: 'the workspace mapping is the directory strategy with the hooks and no repoRoot',
            ok: workspaceOptions.root === join(dir, 'workspaces')
                && workspaceOptions.strategy === 'directory'
                && !('repoRoot' in workspaceOptions)
                && workspaceOptions.baseRef === 'HEAD'
                && workspaceOptions.branchPrefix === 'merci/'
                && workspaceOptions.hooks.afterCreate === 'echo workspace-ready'
                && workspaceOptions.hooks.beforeRun === null
                && workspaceOptions.hooks.timeoutMs === 60_000,
            detail: {
                expected: `${join(dir, 'workspaces')} · directory · no repoRoot · HEAD · merci/ · afterCreate "echo workspace-ready" · beforeRun null · timeout 60000`,
                observed: `${workspaceOptions.root} · ${workspaceOptions.strategy} · ${'repoRoot' in workspaceOptions ? `repoRoot ${String(workspaceOptions.repoRoot)}` : 'no repoRoot'} · ${workspaceOptions.baseRef} · ${workspaceOptions.branchPrefix} · afterCreate ${JSON.stringify(workspaceOptions.hooks.afterCreate)} · beforeRun ${String(workspaceOptions.hooks.beforeRun)} · timeout ${workspaceOptions.hooks.timeoutMs}`,
            },
        });
        audit.end();

        // ── D: last known good ───────────────────────────────────────────────
        audit.scenario({
            id: 'D', title: 'last known good',
            goal: 'a broken edit keeps the old prompt and blocks preflight, a fixed edit swaps it, and stop() is final',
            expect: 'reload of invalid YAML: changed false, healthy false, reasons include workflow_parse_error, preflight returns them, the old prompt still renders · a fixed reload: changed true, healthy true, preflight [] · stop(): preflight ["stopped"]',
            fails: [
                { code: 'dropped-last-good', symptom: 'the old prompt stopped rendering after a bad edit', hint: 'only a full read/resolve/parse swaps the effective state' },
                { code: 'open-preflight', symptom: 'preflight returned [] while unhealthy', hint: 'lastError reasons are what preflight returns' },
                { code: 'stop-ignored', symptom: 'preflight did not report stopped', hint: 'stop() is final and outranks every other state' },
            ],
            input: { edits: ['invalid YAML', 'repaired file'], stop: true },
        });

        await writeFile(path, brokenMarkdown());
        const broken = await policy.reload();
        audit.observe({ name: 'broken reload', value: broken });
        audit.check({
            name: 'a broken edit keeps the last good state and records the parse reason',
            ok: broken.changed === false && broken.healthy === false
                && broken.reasons.some((reason) => reason.startsWith('workflow_parse_error'))
                && policy.snapshot().healthy === false,
            detail: {
                expected: 'changed false · healthy false · a workflow_parse_error reason · snapshot unhealthy',
                observed: `changed ${String(broken.changed)} · healthy ${String(broken.healthy)} · reasons ${JSON.stringify(broken.reasons)} · snapshot healthy ${String(policy.snapshot().healthy)}`,
            },
        });
        audit.check({
            name: 'a policy-only reload still updates the mapped preflight (the closure is live)',
            // The mapping was built before the edit; its preflight must read the
            // policy's current health, not the health at mapping time.
            ok: JSON.stringify(schedulerOptions.preflight()) === JSON.stringify(broken.reasons),
            detail: {
                expected: JSON.stringify(broken.reasons),
                observed: JSON.stringify(schedulerOptions.preflight()),
            },
        });
        audit.check({
            name: 'preflight returns the failure reasons and the old prompt still renders',
            ok: JSON.stringify(policy.preflight()) === JSON.stringify(broken.reasons)
                && policy.renderPrompt({ issue: ISSUE, attempt: null }) === firstAttempt,
            detail: {
                expected: `preflight ${JSON.stringify(broken.reasons)} · the startup prompt`,
                observed: `preflight ${JSON.stringify(policy.preflight())} · prompt ${policy.renderPrompt({ issue: ISSUE, attempt: null }) === firstAttempt ? 'unchanged' : 'changed'}`,
            },
        });

        await writeFile(path, workflowMarkdown({ root, trailer: '\n' }));
        const repaired = await policy.reload();
        audit.observe({ name: 'repaired reload', value: repaired });
        audit.check({
            name: 'a fixed edit swaps the state and clears preflight',
            ok: repaired.changed === true && repaired.healthy === true && repaired.reasons.length === 0
                && policy.snapshot().healthy === true
                && JSON.stringify(policy.preflight()) === JSON.stringify([]),
            detail: {
                expected: 'changed true · healthy true · reasons [] · snapshot healthy · preflight []',
                observed: `changed ${String(repaired.changed)} · healthy ${String(repaired.healthy)} · reasons ${JSON.stringify(repaired.reasons)} · snapshot healthy ${String(policy.snapshot().healthy)} · preflight ${JSON.stringify(policy.preflight())}`,
            },
        });

        policy.stop();
        audit.check({
            name: 'stop() is final and preflight reports stopped',
            ok: JSON.stringify(policy.preflight()) === JSON.stringify(['stopped'])
                && policy.snapshot().stopped === true,
            detail: {
                expected: 'preflight ["stopped"] · snapshot.stopped true',
                observed: `preflight ${JSON.stringify(policy.preflight())} · snapshot.stopped ${String(policy.snapshot().stopped)}`,
            },
        });
        audit.end();

        // ── E: payload hygiene ───────────────────────────────────────────────
        audit.scenario({
            id: 'E', title: 'payload hygiene',
            goal: 'a literal secret in tracker.provider never reaches snapshot() or an emitted event',
            expect: 'the resolved provider holds the SECRET_ sentinel · snapshot() at start and after stop do not · the captured event trail does not (and is non-empty)',
            fails: [
                { code: 'leak', symptom: 'the SECRET_ sentinel appeared in a snapshot or event', hint: 'redactConfig reports provider keys only; event payloads are codes, counts and paths' },
                { code: 'vacuous', symptom: 'the check passed because nothing was captured', hint: 'the captured count is part of the assertion' },
            ],
            input: { sentinel: 'SECRET_', destination: 'tracker.provider' },
        });

        const configHasSecret = JSON.stringify(policy.getConfig()?.tracker.provider ?? {}).includes(SECRET);
        const startedJson = JSON.stringify(started);
        const stoppedJson = JSON.stringify(policy.snapshot());
        const eventsJson = JSON.stringify(events);
        audit.observe({ name: 'captured events', value: events.map((entry) => entry.event) });
        audit.check({
            name: 'the secret is in the config but never in a snapshot or an event',
            ok: configHasSecret
                && !startedJson.includes(SECRET)
                && !stoppedJson.includes(SECRET)
                && events.length > 0
                && !eventsJson.includes(SECRET)
                && events.some((entry) => entry.event === EVENTS.WORKFLOW_POLICY.LOADED)
                && events.some((entry) => entry.event === EVENTS.WORKFLOW_POLICY.RELOADED)
                && events.some((entry) => entry.event === EVENTS.WORKFLOW_POLICY.RELOAD_FAILED),
            detail: {
                expected: 'provider holds SECRET_ · no snapshot/event leaks it · loaded, reloaded and reload_failed captured',
                observed: `config ${configHasSecret ? 'has' : 'lost'} the sentinel · start ${startedJson.includes(SECRET) ? 'leaked' : 'clean'} · stop ${stoppedJson.includes(SECRET) ? 'leaked' : 'clean'} · ${events.length} events ${eventsJson.includes(SECRET) ? 'leaked' : 'clean'} · ${events.map((entry) => entry.event).join(', ')}`,
            },
        });
        audit.end();

        if (live !== null && usage !== null) reportUsage({ provider: live.provider, usage });
        log.success({ m: 'Workflow contract verified: a repo-owned file, strict rendering, the mapping, last-known-good reload.' });
    } finally {
        policy.stop();
        await rm(dir, { recursive: true, force: true });
    }
}

// The await matters: without it a stalled run would exit 0 with a truncated log.
await audit.run(main);
