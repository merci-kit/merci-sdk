// @ts-check
/**
 * Example 31 — One call: policy + scheduler + workspace + operator.
 *
 * The primitives have their own examples; this one is the composition root.
 * A repository-owned `WORKFLOW.md` says how work runs, a three-item board says
 * what work exists, and one `createOrchestration` call binds the two to a
 * policy, a scheduler, a workspace manager and an operator surface:
 *
 *   A — one call      : `policy.snapshot()` is started and healthy, the
 *       scheduler took its interval, active/terminal states and concurrency
 *       from the file, and the workspace manager, ring and HTTP handler exist.
 *   B — two items     : `start()` dispatches both Todo items under the file's
 *       cap of 2, each in its own workspace directory, and the third item stays
 *       in Backlog because the board says it is not active work.
 *   C — the operator  : `GET /api/v1/state` is the live counts and totals,
 *       `/api/v1/items/<id>` is one item (status `parked` — the documented end
 *       of a completed attempt when continuations are off), `/` is the
 *       `formatStatus` page, and `POST /api/v1/refresh` moves the tick count.
 *   D — the ring      : `createEventRing` keeps the projected history. The
 *       default `DEFAULT_PREFIXES` omit session records; passing
 *       `prefixes: [...DEFAULT_PREFIXES, 'session:']` opts them in. A host mount
 *       of `createOperatorHttpHandler` reads the same system, and its item feed
 *       stays item-scoped: a record without an identifier cannot belong to it.
 *   E — the spend     : one DAG attempt hands `planFor` a cap-less ledger. The
 *       hook's own session, the engine's objective restatement and the step all
 *       fold into `totals`; a call through the client the host kept stays out.
 *
 * What this shows:
 *   - the file owns interval, states, concurrency and the workspace root
 *   - the model is passed by the host and never read from the contract
 *   - one attempt's spend is a ledger, not an estimate; `budget` bounds a unit
 *   - the operator reports the same snapshot the host can read
 *
 * Run: `node examples/31_orchestration.mjs`
 * Needs: provider credentials in `secret.env` (`PROVIDER=google_genai`).
 *
 * @version 0.23.0
 */
import { createServer } from 'node:http';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EVENTS, MerciEventEmitter, initializeClient, loadCredentials, log } from 'merci-sdk';
import { LocalFileSessionStore } from 'merci-sdk/sessions';
import {
    DEFAULT_PREFIXES, OPERATOR_API_VERSION, OPERATOR_DEFAULTS, createEventRing, createOperatorHttpHandler, formatStatus,
} from 'merci-sdk/operator';
import { createOrchestration } from 'merci-sdk/orchestration';
import { createMemoryWorkSource } from 'merci-sdk/scheduler';
import { SCRATCH_DIR } from './_shared/real-tools.mjs';
import { reportUsage, resolveExample, runMain, trackUsage, wireClient } from './_shared/example-utils.mjs';

const STATE_DIR = join(SCRATCH_DIR, '31-orchestration');
const WORKSPACE_ROOT = join(STATE_DIR, 'workspaces');
const WORKFLOW_FILE = join(STATE_DIR, 'WORKFLOW.md');
const ITEMS = [
    { id: 'i-31a', identifier: 'MER-31A', title: 'Orchestration item A', state: 'Todo', dispatchable: true, priority: 1 },
    { id: 'i-31b', identifier: 'MER-31B', title: 'Orchestration item B', state: 'Todo', dispatchable: true, priority: 2 },
    { id: 'i-31c', identifier: 'MER-31C', title: 'Waiting in the tracker', state: 'Backlog', dispatchable: true, priority: 3 },
];
const ACTIVE = ['MER-31A', 'MER-31B'];
const WAITING = 'MER-31C';

/**
 * The repo-owned contract: two active items at a time, no continuations, and
 * the workspace root under this run's scratch directory.
 * @returns {string}
 */
const contract = () => [
    '---',
    'tracker:',
    '  kind: memory',
    '  active_states: [Todo]',
    '  terminal_states: [Done]',
    'polling:',
    '  interval_ms: 3600000',
    'workspace:',
    `  root: ${JSON.stringify(WORKSPACE_ROOT)}`,
    'agent:',
    '  max_concurrent_agents: 2',
    'merci:',
    '  scheduler:',
    '    continuation_max: 0',
    '---',
    'Work on {{ issue.identifier }}.',
].join('\n');

/** @param {{url: string, method?: string, body?: string|null}} arg0 */
async function request({ url, method = 'GET', body = null }) {
    const response = await fetch(url, {
        method,
        ...(body === null ? {} : { headers: { 'content-type': 'application/json' }, body }),
    });
    const text = await response.text();
    return { status: response.status, type: response.headers.get('content-type') ?? '', text, json: text.startsWith('{') ? JSON.parse(text) : null };
}

/** @param {{predicate: () => boolean, timeoutMs?: number}} arg0 */
async function waitFor({ predicate, timeoutMs = 120_000 }) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the orchestration');
        await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
}

async function main() {
    const { provider, toolModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });
    let apiCalls = 0;
    client.on('api_request', () => { apiCalls += 1; });

    log.header({ t: `Example 31 — One call: policy + scheduler + workspace + operator (${provider})` });
    await rm(STATE_DIR, { recursive: true, force: true });
    await mkdir(WORKSPACE_ROOT, { recursive: true });
    await writeFile(WORKFLOW_FILE, contract(), 'utf8');
    log.option({ name: 'contract', value: WORKFLOW_FILE, source: 'tracker, polling, workspace.root, agent and merci.scheduler' });
    log.option({ name: 'board', value: `${ITEMS.length} items in memory · ${ACTIVE.length} Todo · ${WAITING} Backlog`, source: 'createMemoryWorkSource({ items })' });
    log.option({ name: 'model', value: toolModel, source: 'createOrchestration({ model }) — never read from WORKFLOW.md' });
    log.option({ name: 'engine', value: 'dag · planFor hook', source: 'createOrchestration({ engine, runner: { planFor } })' });

    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    const emitter = new MerciEventEmitter();
    // The facade types `store` as an index-signature record; the JSON store is
    // still one `{ load, save }` object, so this is the only place it is cast.
    const store = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (new LocalFileSessionStore({ dir: join(STATE_DIR, 'checkpoints'), eventEmitter: emitter })));
    /** @type {Array<{attempt: number|null, cap: number|null, hookBefore: number, hookAfter: number}>} */
    const hookViews = [];
    /** @type {any} */
    let system = null;
    /** @type {import('node:http').Server|null} */
    let hostServer = null;
    /** @type {ReturnType<typeof createEventRing>|null} */
    let optInRing = null;

    try {
        // ── A · one call binds the layer ─────────────────────────────────────
        log.section({ t: 'A — createOrchestration: one call, one system' });
        log.info({ m: 'The policy resolves first, so the scheduler is built from the file it just loaded. The same emitter feeds the ring and the operator handler.' });
        system = await createOrchestration({
            client,
            model: toolModel,
            workSource: createMemoryWorkSource({ items: ITEMS }),
            workflowFile: WORKFLOW_FILE,
            policyOptions: { watch: false },
            engine: 'dag',
            // One shared emitter: the scheduler, the ring and the host's rings.
            emitter,
            // One unit's cap; the attempt ledger the hook sees is cap-less.
            budget: { maxTotalTokens: 8_000 },
            store,
            approval: () => true,
            operator: true,
            ring: { limit: 200 },
            scheduler: { continuation: { delayMs: 0, max: 0 } },
            runner: {
                /** @param {{item: {identifier: string}, attempt: number|null, client: any, budgetPool: any}} args */
                planFor: async ({ item, attempt, client: attemptClient, budgetPool }) => {
                    const hookBefore = Number(budgetPool?.usage?.total_tokens ?? 0);
                    await attemptClient.session(toolModel).run({ initialInput: `Restate the plan for ${item.identifier} in one line.` });
                    const hookAfter = Number(budgetPool?.usage?.total_tokens ?? 0);
                    hookViews.push({ attempt, cap: budgetPool?.maxTotalTokens ?? null, hookBefore, hookAfter });
                    return {
                        objective: `Answer for ${item.identifier}`,
                        context: {},
                        steps: [{ id: 'answer', title: 'Answer', systemPrompt: 'One short line.', userPromptTemplate: `Reply with exactly ORCH-${item.identifier}` }],
                    };
                },
            },
        });
        optInRing = createEventRing({ emitter, limit: 200, prefixes: [...DEFAULT_PREFIXES, 'session:'] });

        const policy = system.policy.snapshot();
        const snapshot = system.scheduler.snapshot();
        log.list({
            title: 'what the one call built',
            items: [
                `policy     : started ${policy.started} · healthy ${policy.healthy} · watch ${policy.watch}`,
                `scheduler  : every ${snapshot.pollIntervalMs}ms · ${snapshot.activeStates.join('/')} → ${snapshot.terminalStates.join('/')} · ${snapshot.limits.maxAttemptsPerItem} attempt(s)`,
                `workspace  : ${system.workspace === null ? 'none' : system.workspace.root}`,
                `operator   : handler ${typeof system.handler} · ring ${system.ring === null ? 'none' : 'present'}`,
            ],
        });
        check({
            name: 'the policy resolved first and the scheduler follows the file',
            ok: policy.started === true && policy.healthy === true
                && snapshot.pollIntervalMs === 3_600_000
                && snapshot.activeStates.join(',') === 'Todo' && snapshot.terminalStates.join(',') === 'Done'
                && snapshot.limits.maxAttemptsPerItem >= 1,
            detail: `started ${policy.started} · healthy ${policy.healthy} · interval ${snapshot.pollIntervalMs} · states ${snapshot.activeStates.join('/')} → ${snapshot.terminalStates.join('/')}`,
        });
        check({
            name: 'the workspace manager, the ring and the HTTP handler exist',
            ok: system.workspace !== null && system.ring !== null && typeof system.handler === 'function',
            detail: `workspace ${system.workspace === null ? 'no' : 'yes'} · ring ${system.ring === null ? 'no' : 'yes'} · handler ${typeof system.handler}`,
        });

        // ── B · two items, two workspaces, one tick ──────────────────────────
        log.section({ t: 'B — start(): two items, two workspaces, concurrently' });
        log.info({ m: `The file caps the pool at 2, so the first tick claims both Todo items. Each attempt gets its own workspace under ${WORKSPACE_ROOT}; the Backlog item is not active work.` });
        /** @type {Array<Record<string, any>>} */
        const dispatched = [];
        /** @type {Array<Record<string, any>>} */
        const created = [];
        system.emitter.on(EVENTS.WORK_ITEM.DISPATCHED, (/** @type {any} */ event) => dispatched.push(event));
        system.emitter.on(EVENTS.WORKSPACE.CREATED, (/** @type {any} */ event) => created.push(event));

        await system.start();
        await waitFor({ predicate: () => system !== null && system.scheduler.snapshot().completed.length >= 2 });

        const finalSnapshot = system.scheduler.snapshot();
        const runIdOf = (/** @type {string} */ identifier) => dispatched.find((event) => event.identifier === identifier)?.runId ?? null;
        const correlated = ACTIVE.every((identifier) => created.some((event) => event.workItemId === identifier && event.runId === runIdOf(identifier)));
        log.list({
            title: 'dispatched and placed',
            items: ACTIVE.map((identifier) => {
                const workspace = created.find((event) => event.workItemId === identifier);
                return `${identifier} · run ${String(runIdOf(identifier))} · ${String(workspace?.path)}`;
            }),
        });
        check({
            name: 'both active items ran together, each in its own correlated workspace',
            ok: finalSnapshot.completed.includes('MER-31A') && finalSnapshot.completed.includes('MER-31B')
                && finalSnapshot.totals.dispatches === 2
                && created.length === 2 && new Set(created.map((event) => event.path)).size === 2
                && created.every((event) => existsSync(String(event.path))) && correlated
                && !finalSnapshot.completed.includes(WAITING),
            detail: `completed [${finalSnapshot.completed.join(',')}] · ${created.length} workspace(s) · distinct ${new Set(created.map((event) => event.path)).size} · correlated ${correlated}`,
        });
        check({
            name: 'every workspace sits under the root the contract named',
            ok: created.every((event) => String(event.path).startsWith(realpathSync(WORKSPACE_ROOT)))
                && system.workspace?.handleFor({ workItemId: 'MER-31A' })?.root === realpathSync(WORKSPACE_ROOT),
            detail: created.map((event) => String(event.path).replace(String(WORKSPACE_ROOT), '…')).join(' · '),
        });

        // ── C · the operator reports the live system ─────────────────────────
        log.section({ t: 'C — the operator surface: state, detail, page, refresh' });
        const listening = await system.listen();
        log.option({ name: 'operator', value: listening.url, source: 'orchestration.listen()' });
        const state = await request({ url: `${listening.url}/api/v1/state` });
        const page = await request({ url: `${listening.url}/` });
        const detail = await request({ url: `${listening.url}/api/v1/items/MER-31A` });
        const rendered = formatStatus({ snapshot: system.scheduler.snapshot(), policy: system.policy.snapshot() });
        const totalsLine = (/** @type {string} */ text) => text.split('\n').find((line) => line.startsWith('Totals:')) ?? '';
        log.option({ name: 'state', value: `completed ${String(state.json?.counts?.completed)} · dispatches ${String(state.json?.totals?.dispatches)} · tokens ${String(state.json?.totals?.totalTokens)}`, source: 'GET /api/v1/state' });
        log.option({ name: 'detail', value: `${String(detail.json?.status)} · ${String(detail.json?.recentEvents?.length)} event(s)`, source: 'GET /api/v1/items/MER-31A' });
        check({
            name: 'state, detail and the status page all read the same live system',
            ok: state.status === 200 && state.type.startsWith('application/json')
                && state.json?.counts?.completed === 2 && state.json?.policy?.healthy === true
                && detail.status === 200 && detail.json?.identifier === 'MER-31A'
                && (detail.json?.recentEvents ?? []).length > 0
                && !JSON.stringify(state.json).includes('Orchestration item')
                && page.status === 200 && page.type.startsWith('text/plain')
                && totalsLine(page.text) === totalsLine(rendered) && page.text.includes('Policy:')
                && OPERATOR_DEFAULTS.basePath === '/api/v1' && OPERATOR_API_VERSION === 1,
            detail: `state ${state.status} · completed ${String(state.json?.counts?.completed)} · detail ${String(detail.json?.status)} · page totals "${totalsLine(page.text)}" · api v${OPERATOR_API_VERSION}`,
        });

        const beforeTick = system.scheduler.snapshot().tickCount;
        const refresh = await request({ url: `${listening.url}/api/v1/refresh`, method: 'POST', body: '{}' });
        const afterTick = system.scheduler.snapshot().tickCount;
        log.option({ name: 'refresh', value: `${refresh.status} · queued ${String(refresh.json?.queued)} · ${String((refresh.json?.operations ?? []).join('+'))}`, source: 'POST /api/v1/refresh' });
        check({
            name: 'a refresh queues exactly one tick without a restart',
            ok: refresh.status === 202 && refresh.json?.queued === true && afterTick === beforeTick + 1
                && OPERATOR_DEFAULTS.allowedHosts.includes('127.0.0.1') && OPERATOR_DEFAULTS.statusPath === '/',
            detail: `refresh ${refresh.status} · tick ${beforeTick} → ${afterTick} · hosts ${OPERATOR_DEFAULTS.allowedHosts.join(',')} · status ${OPERATOR_DEFAULTS.statusPath}`,
        });

        // ── D · the ring and the session-record opt-in ───────────────────────
        log.section({ t: 'D — the event ring, and the session records it leaves out' });
        log.info({ m: 'The store wrote one checkpoint per item, and each save emits a `session:store_saved` record. The default ring records only scheduler, work-item, workspace and policy namespaces; the opt-in ring adds the session prefix. An item feed filters by identifier, so the wider ring never leaks into it.' });
        /** @type {Array<Record<string, any>>} */
        const scoped = system.ring?.list({ identifier: 'MER-31A' }) ?? [];
        /** @type {Array<Record<string, any>>} */
        const defaultFeed = system.ring?.list({ limit: 200 }) ?? [];
        /** @type {Array<Record<string, any>>} */
        const optInFeed = optInRing.list({ limit: 200 });
        const sessionRecords = (/** @type {Array<Record<string, any>>} */ feed) => feed.filter((record) => String(record.event).startsWith('session:'));
        log.option({ name: 'default prefixes', value: DEFAULT_PREFIXES.join(' '), source: 'DEFAULT_PREFIXES — no `session:`' });
        log.option({ name: 'opt-in prefixes', value: [...DEFAULT_PREFIXES, 'session:'].join(' '), source: "ring: { prefixes: [...DEFAULT_PREFIXES, 'session:'] }" });
        log.option({ name: 'rings', value: `default ${defaultFeed.length} record(s) / ${sessionRecords(defaultFeed).length} session · opt-in ${optInFeed.length} / ${sessionRecords(optInFeed).length}`, source: 'createEventRing({ emitter, prefixes })' });
        check({
            name: 'the default ring omits session records and the opt-in ring keeps them',
            ok: sessionRecords(defaultFeed).length === 0 && sessionRecords(optInFeed).length >= 2
                && scoped.length > 0 && scoped.every((record) => record.identifier === 'MER-31A')
                && optInFeed.some((record) => record.event === 'work_item:completed'),
            detail: `default session ${sessionRecords(defaultFeed).length} · opt-in session ${sessionRecords(optInFeed).length} · item feed ${scoped.length}`,
        });

        // A host may mount its own handler: this one serves the wider feed.
        const hostHandler = createOperatorHttpHandler({
            getSnapshot: () => /** @type {any} */ (system).scheduler.snapshot(),
            getPolicySnapshot: () => /** @type {any} */ (system).policy.snapshot(),
            recentEvents: ({ limit }) => optInRing?.list({ limit: limit ?? 50 }) ?? [],
        });
        hostServer = createServer((req, res) => { void hostHandler(req, res); });
        await new Promise((resolve) => { hostServer?.listen(0, '127.0.0.1', () => resolve(undefined)); });
        const hostPort = /** @type {import('node:net').AddressInfo} */ (hostServer.address()).port;
        const hostState = await request({ url: `http://127.0.0.1:${hostPort}/api/v1/state` });
        const hostDetail = await request({ url: `http://127.0.0.1:${hostPort}/api/v1/items/MER-31A` });
        const hostSession = sessionRecords(hostDetail.json?.recentEvents ?? []);
        log.option({ name: 'host mount', value: `http://127.0.0.1:${hostPort} · state ${hostState.status} · detail ${hostDetail.status}`, source: 'createOperatorHttpHandler({ recentEvents })' });
        check({
            name: 'a host mount reads the same system, and an item feed stays item-scoped',
            ok: hostState.status === 200 && hostState.json?.counts?.completed === 2
                && hostDetail.status === 200 && hostDetail.json?.identifier === 'MER-31A'
                && hostSession.length === 0
                && (hostDetail.json?.recentEvents ?? []).length === (detail.json?.recentEvents ?? []).length,
            detail: `${hostState.status} · ${String(hostState.json?.counts?.completed)} completed · item feed ${String(hostDetail.json?.recentEvents?.length)} record(s), ${hostSession.length} session — a record with no identifier cannot belong to an item`,
        });

        // ── E · what one orchestrated attempt cost ───────────────────────────
        log.section({ t: 'E — the spend ledger: the hook, the engine and the step' });
        const totals = system.scheduler.snapshot().totals;
        const hookTokens = hookViews.reduce((sum, view) => sum + view.hookAfter, 0);
        log.list({
            title: 'one attempt, three spenders',
            items: [
                `hook session   : ${hookViews.map((view) => `${view.hookAfter - view.hookBefore} tokens`).join(' + ')} · cap ${hookViews.map((view) => String(view.cap)).join('/')}`,
                `engine + step  : the objective restatement and the DAG step, folded after the hook returned`,
                `scheduler total: ${totals.totalTokens} tokens · ${totals.dispatches} dispatch(es) · ${totals.attempts} attempt(s)`,
                `vendor calls   : ${apiCalls} so far`,
            ],
        });
        const beforeHost = system.scheduler.snapshot().totals.totalTokens;
        const callsBeforeHost = apiCalls;
        await client.session(toolModel).run({ initialInput: 'Host-side bookkeeping, outside any attempt.' });
        const afterHost = system.scheduler.snapshot().totals.totalTokens;
        log.option({ name: 'host call', value: `${apiCalls - callsBeforeHost} vendor call · ledger ${beforeHost} → ${afterHost}`, source: 'client.session(model).run() — the client the host kept' });
        check({
            name: 'the totals hold the hook, the objective restatement and the step',
            ok: totals.dispatches === 2 && totals.attempts === 2 && totals.failures === 0
                && hookViews.length === 2 && hookViews.every((view) => view.hookAfter > view.hookBefore)
                && totals.totalTokens > hookTokens,
            detail: `totals ${totals.totalTokens} > hook calls ${hookTokens} · attempts ${totals.attempts} · failures ${totals.failures}`,
        });
        check({
            name: 'the attempt ledger is report-only and a host-client call stays out of it',
            ok: hookViews.every((view) => view.cap === null) && afterHost === beforeHost && apiCalls > callsBeforeHost,
            detail: `hook cap ${hookViews.map((view) => String(view.cap)).join('/')} · ledger ${beforeHost} → ${afterHost} across ${apiCalls - callsBeforeHost} call(s)`,
        });

        const counts = await system.stop();
        system = null;
        log.option({ name: 'stop', value: `drained ${counts.drained} · running ${counts.running} · policy stopped`, source: 'orchestration.stop()' });
        check({
            name: 'one stop drains the work, closes the surface and stops the policy',
            ok: counts.drained === true && counts.running === 0,
            detail: JSON.stringify(counts),
        });
    } finally {
        optInRing?.stop();
        if (hostServer !== null) {
            hostServer.closeAllConnections();
            await new Promise((resolve) => { hostServer?.close(() => resolve(undefined)); });
        }
        if (system !== null) {
            await system.close().catch(() => {});
            await system.stop().catch(() => {});
        }
        reportUsage({ provider, usage });
    }

    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'One call bound the file, the board, the workspaces and the operator — and the ledger told the whole cost.' });
    else log.warn({ m: `${failures}/${checks} check(s) failed — inspect the log above.` });
}

runMain({ mainFn: main });
