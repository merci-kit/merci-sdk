// @ts-check
/**
 * Example 32 — The engine runner: one attempt, four engines.
 *
 * `createEngineRunner` is the adapter between a scheduler attempt and an
 * engine. The scheduler owns claims, retries, parking and workspaces; the
 * runner owns exactly one attempt: it builds the engine, passes the attempt's
 * signal, tools, budget and approval, restores a checkpoint with the engine's
 * real rehydration args, and reports only this attempt's usage.
 *
 *   A — select and refuse    : every engine constructs; a missing required
 *       option is a `ConfigurationError` with a named option, and a discussion
 *       store with `resume` is refused because that engine has no checkpoint.
 *   B — agentic              : a fluent scripted session proves the adapter's
 *       wiring — store, thread id, execution journal, tools, approval, progress,
 *       usage and summary — without a model call.
 *   C — DAG                  : the REAL `WorkflowExecutor` runs a static plan
 *       from `planFor`, saves a checkpoint in a `finally`, and restores on a
 *       second attempt.
 *   D — state machine        : the REAL `StateMachine` runs the `graphFor`
 *       graph and saves its own checkpoint.
 *   E — discussion           : the REAL `DiscussionSession` runs function
 *       agents; an accepted verdict completes and a rejected one fails.
 *   F — live                 : the same four adapters against the configured
 *       backend; each engine's forced marker proves a real run.
 *
 * Public API: `createEngineRunner`, `ExecutionJournal`, `WorkflowExecutor`,
 * `StateMachine`, `DiscussionSession`, `RunContext`, `log`.
 *
 * Run: `node test/examples/32_engine_runner.mjs` (live) · `node test/examples/32_engine_runner.mjs --offline` (deterministic)
 * Needs: `BACKEND` + provider credentials in `secret.env` for the live engines;
 *        `--offline` needs none.
 *
 * @version 0.12.0
 */
import { EVENTS, RunContext, initializeClient, loadCredentials, log } from 'merci-sdk';
import { createEngineRunner } from 'merci-sdk/scheduler';
import { createAudit } from '../../examples/_shared/example-audit.mjs';
import { reportUsage, resolveExample, trackUsage, wireClient } from '../../examples/_shared/example-utils.mjs';

const OFFLINE = process.argv.includes('--offline');
const live = OFFLINE ? null : resolveExample();

const audit = createAudit({
    metaUrl: import.meta.url,
    id: 'audit/32_engine_runner',
    offline: OFFLINE,
    provider: live?.provider ?? null,
    models: live ? live.toolModel : null,
    title: 'Example 32 — The engine runner',
});

/**
 * A work item in the shape the scheduler dispatches.
 * @typedef {object} WorkItem
 * @property {string} id
 * @property {string} identifier
 * @property {string} title
 * @property {string} state
 * @property {boolean} dispatchable
 * @property {string[]} labels
 * @property {number|null} priority
 * @property {number|null} createdAt
 * @property {number|null} updatedAt
 * @property {string} lane
 * @property {any} nativeRef
 * @property {any} metadata
 * @property {any[]} blockedBy
 * @property {string|null} description
 * @property {string|null} url
 */

/**
 * A work item in the shape the scheduler dispatches.
 * @param {{identifier?: string}} [arg0] -
 * @returns {WorkItem}
 */
const workItem = ({ identifier = 'MER-320' } = {}) => /** @type {any} */ ({
    id: `id-${identifier}`,
    identifier,
    title: `Work ${identifier}`,
    state: 'Todo',
    dispatchable: true,
    labels: [],
    priority: 1,
    createdAt: null,
    updatedAt: null,
    lane: 'default',
    nativeRef: null,
    metadata: null,
    blockedBy: [],
    description: null,
    url: null,
});

/**
 * One attempt's arguments, including the progress counter the adapter uses.
 * @param {{identifier?: string, attempt?: number|null, runId?: string}} [arg0] -
 * @returns {{
 *   item: WorkItem,
 *   attempt: number|null,
 *   workspace: null,
 *   signal: AbortSignal,
 *   runContext: RunContext,
 *   reportProgress: () => void,
 *   progress: { count: number }
 * }}
 */
function attemptArgs({ identifier = 'MER-320', attempt = 1, runId = 'runner-run' } = {}) {
    const progress = { count: 0 };
    return {
        item: workItem({ identifier }),
        attempt,
        workspace: null,
        signal: new AbortController().signal,
        runContext: new RunContext({ runId }),
        reportProgress: () => { progress.count += 1; },
        progress,
    };
}

/**
 * A fluent session for the agentic adapter. Every builder call is recorded and
 * `run()` is scripted, so the wiring is observable with no model.
 * @param {{run?: ((arg0: { session: Record<string, any>, args: { initialInput: unknown, options: Record<string, any> } }) => unknown)|null, usage?: Record<string, number>|null, checkpoint?: Record<string, unknown>|null}} [arg0] -
 */
function agenticClient({ run = null, usage = { total_tokens: 7 }, checkpoint = null } = {}) {
    /** @type {Array<Record<string, any>>} */
    const sessions = [];
    return {
        sessions,
        /** @param {string} model @returns {Record<string, any>} */
        session(model) {
            /** @type {Record<string, any>} */
            const session = {
                provider: 'offline',
                model,
                checkpoint,
                loaded: 0,
                store: null,
                threadId: null,
                journal: null,
                tools: null,
                budget: null,
                approvals: [],
                input: null,
                runOptions: null,
                _lastRunUsage: usage,
                withSessionStore(/** @type {{store: unknown, threadId: string}} */ args) { session.store = args.store; session.threadId = args.threadId; return session; },
                withExecutionJournal(/** @type {{journal: unknown}} */ args) { session.journal = args.journal; return session; },
                withTools(/** @type {{tools: unknown[]}} */ args) { session.tools = args.tools; return session; },
                withBudget(/** @type {{budget: unknown}} */ args) { session.budget = args.budget; return session; },
                withApproval(/** @type {Record<string, unknown>} */ args) { session.approvals.push(args); return session; },
                async loadCheckpoint() { session.loaded += 1; return session.checkpoint; },
                async run(/** @type {{initialInput: unknown, options: Record<string, any>}} */ args) {
                    session.input = args.initialInput;
                    session.runOptions = args.options;
                    return run ? run({ session, args }) : 'AGENTIC-OFFLINE-ANSWER';
                },
            };
            sessions.push(session);
            return session;
        },
    };
}

/**
 * The model client the DAG and state-machine engines use for their nodes. It
 * speaks the fluent contract and returns a fixed answer.
 * @param {{answer?: string, usage?: Record<string, number>, run?: ((arg0: {session: Record<string, any>}) => unknown)|null}} [arg0] -
 */
function modelClient({ answer = 'NODE-OFFLINE-ANSWER', usage = { total_tokens: 4 }, run = null } = {}) {
    /** @type {Array<Record<string, any>>} */
    const sessions = [];
    return {
        sessions,
        /** @param {string} model @returns {Record<string, any>} */
        session(model) {
            /** @type {Record<string, any>} */
            const session = {
                provider: 'offline',
                model,
                _lastRunUsage: usage,
                withSystemMessage() { return session; },
                withTools() { return session; },
                withMemory() { return session; },
                withTodos() { return session; },
                withParameters() { return session; },
                withPromptCache() { return session; },
                withCircuitBreaker() { return session; },
                withRetryPolicy() { return session; },
                withStreamTimeout() { return session; },
                withApproval() { return session; },
                withBudget() { return session; },
                async run() {
                    session._lastRunUsage = usage;
                    return run ? run({ session }) : answer;
                },
            };
            sessions.push(session);
            return session;
        },
    };
}

/**
 * The discussion judge: it answers with the structured verdict the session
 * expects, so no model is called.
 * @param {boolean} accepted -
 */
function judgeClient(accepted) {
    return {
        provider: 'offline',
        /** @returns {Record<string, unknown>} */
        session() {
            /** @type {Record<string, any>} */
            const session = {
                provider: 'offline',
                withSystemMessage() { return session; },
                withTools() { return session; },
                withTodos() { return session; },
                withMemory() { return session; },
                withParameters() { return session; },
                withRetryPolicy() { return session; },
                withStreamTimeout() { return session; },
                withCircuitBreaker() { return session; },
                withApproval() { return session; },
                withBudget() { return session; },
                withPromptCache() { return session; },
                async run() {
                    session._lastRunUsage = { total_tokens: 4 };
                    return JSON.stringify({ passed: accepted, score: accepted ? 90 : 10, reason: 'offline verdict', revision: 'minor' });
                },
            };
            return session;
        },
    };
}

/**
 * A store the runner can `load`/`save`, with its call log.
 * @param {Record<string, Record<string, unknown>>} [initial] -
 */
function createStore(initial = {}) {
    /** @type {Map<string, Record<string, unknown>>} */
    const records = new Map(Object.entries(initial));
    /** @type {Array<{ op: string, threadId: string, data?: Record<string, unknown> }>} */
    const calls = [];
    return {
        records,
        calls,
        async load(/** @type {string} */ threadId) {
            calls.push({ op: 'load', threadId });
            return records.get(threadId) ?? null;
        },
        async save(/** @type {{threadId: string, data: Record<string, unknown>}} */ { threadId, data }) {
            calls.push({ op: 'save', threadId, data });
            records.set(threadId, data);
            return null;
        },
    };
}

/** @param {string[]} list @returns {string} */
const joined = (list) => (list.length === 0 ? '(none)' : list.join(', '));

async function main() {
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

    // ── A: select and refuse ─────────────────────────────────────────────────
    audit.scenario({
        id: 'A', title: 'select an engine and refuse a broken configuration',
        goal: 'one factory selects the adapter and validates exactly the options that engine needs',
        expect: 'four engines construct · unsupported_engine · missing_client · missing_model · missing_prompt · missing_plan · missing_graph · missing_agents · discussion_no_resume · invalid_store · invalid_approval',
        fails: [
            { code: 'late-throw', symptom: 'a missing option threw at run() instead of construction', hint: 'construction validates every required option before a client is touched' },
            { code: 'coerced', symptom: 'a bad option was silently accepted', hint: 'each refusal carries a named `option`' },
            { code: 'resume-claim', symptom: 'a discussion runner accepted a store with resume', hint: 'the discussion engine has no checkpoint' },
        ],
        input: { engines: ['agentic', 'dag', 'stateMachine', 'discussion'], invalid: 10 },
    });

    const offline = agenticClient();
    const constructed = [
        typeof createEngineRunner({ engine: 'agentic', client: offline, model: 'm', prompt: 'go' }).run,
        typeof createEngineRunner({ engine: 'dag', client: offline, model: 'm', planFor: async () => ({ steps: [] }) }).run,
        typeof createEngineRunner({ engine: 'stateMachine', client: offline, model: 'm', graphFor: () => ({}) }).run,
        typeof createEngineRunner({ engine: 'discussion', client: offline, model: 'm', agents: [] }).run,
    ];
    /** @type {Array<[Record<string, unknown>, string]>} */
    const invalid = [
        [{ engine: 'nope', client: offline, model: 'm' }, 'unsupported_engine'],
        [{ engine: 'agentic', model: 'm', prompt: 'go' }, 'missing_client'],
        [{ engine: 'agentic', client: offline, prompt: 'go' }, 'missing_model'],
        [{ engine: 'agentic', client: offline, model: 'm' }, 'missing_prompt'],
        [{ engine: 'dag', client: offline, model: 'm' }, 'missing_plan'],
        [{ engine: 'stateMachine', client: offline, model: 'm' }, 'missing_graph'],
        [{ engine: 'discussion', client: offline, model: 'm' }, 'missing_agents'],
        [{ engine: 'discussion', client: offline, model: 'm', agents: [], store: createStore() }, 'discussion_no_resume'],
        [{ engine: 'agentic', client: offline, model: 'm', prompt: 'go', store: {} }, 'invalid_store'],
        [{ engine: 'agentic', client: offline, model: 'm', prompt: 'go', approval: {} }, 'invalid_approval'],
    ];
    /** @type {string[]} */
    const refusals = [];
    for (const [options, option] of invalid) {
        const probed = await audit.probe({ fn: () => createEngineRunner(options) });
        refusals.push(`${option}:${String(probed.error?.option ?? 'none')}`);
    }
    audit.observe({ name: 'construction', value: `run is ${constructed.every((kind) => kind === 'function') ? 'a function on all four' : 'missing'}` });
    audit.observe({ name: 'refusals', value: refusals.join(' · ') });
    audit.check({
        name: 'every engine constructs with only its own required options',
        ok: constructed.every((kind) => kind === 'function'),
        detail: { expected: 'four run() functions', observed: joined(constructed.map(String)) },
    });
    audit.check({
        name: 'every invalid configuration is refused with its named option',
        ok: refusals.every((entry) => entry.split(':')[0] === entry.split(':')[1]),
        detail: { expected: 'each refusal names the expected option', observed: refusals.join(' · ') },
    });
    audit.end();

    // ── B: agentic ───────────────────────────────────────────────────────────
    audit.scenario({
        id: 'B', title: 'agentic: the full attempt wiring',
        goal: 'the adapter passes the store, thread id, journal, tools, approval, progress, usage and summary through',
        expect: 'threadId work:MER-321 · one checkpoint load · an ExecutionJournal attached · tools resolved from the item and attempt · the approval normalized · progress refreshed by a session event · usage is this attempt\'s · summary is the final answer',
        fails: [
            { code: 'no-store', symptom: 'withSessionStore was not called', hint: 'a store means resume: the runner attaches it and loads the checkpoint' },
            { code: 'no-journal', symptom: 'withExecutionJournal was not called', hint: 'the agentic adapter attaches an explicit journal for cross-attempt at-most-once' },
            { code: 'no-usage', symptom: 'the reported usage is null', hint: 'usage is read from the session after run(), never accumulated globally' },
        ],
        input: { store: 'memory', tools: 'resolved from { item, attempt, workspace }' },
    });

    const storeB = createStore();
    const clientB = agenticClient({ run: ({ args }) => { args.options.onEvent({ type: 'text', content: 'chunk' }); return 'AGENTIC-ANSWER'; } });
    let hostEvents = 0;
    const runnerB = createEngineRunner({
        engine: 'agentic',
        client: clientB,
        model: 'm',
        store: storeB,
        approval: { fn: () => true },
        prompt: (/** @type {{item: {identifier: string}}} */ { item }) => `work on ${item.identifier}`,
        tools: (/** @type {{item: {identifier: string}, attempt: number|null}} */ { item, attempt }) => [{ name: `tool-${item.identifier}-${attempt}` }],
        onEvent: () => { hostEvents += 1; },
    });
    const argsB = attemptArgs({ identifier: 'MER-321' });
    const resultB = await runnerB.run(argsB);
    const sessionB = /** @type {Record<string, any>} */ (clientB.sessions[0]);
    audit.observe({ name: 'agentic result', value: { status: resultB.status, usage: resultB.usage, summary: resultB.summary, progress: argsB.progress.count, hostEvents } });
    audit.observe({ name: 'agentic session', value: { threadId: sessionB.threadId, loaded: sessionB.loaded, journal: Boolean(sessionB.journal), tools: sessionB.tools, approvals: sessionB.approvals.length } });
    audit.check({
        name: 'the attempt reports a completed run with its own usage and summary',
        ok: resultB.status === 'completed' && resultB.summary === 'AGENTIC-ANSWER'
            && JSON.stringify(resultB.usage) === JSON.stringify({ total_tokens: 7 }),
        detail: {
            expected: 'completed · usage {"total_tokens":7} · summary AGENTIC-ANSWER',
            observed: `${resultB.status} · ${JSON.stringify(resultB.usage)} · ${String(resultB.summary)}`,
        },
    });
    audit.check({
        name: 'the session event refreshed progress and reached the host observer',
        ok: argsB.progress.count === 1 && hostEvents === 1,
        detail: { expected: 'progress 1 · hostEvents 1', observed: `progress ${argsB.progress.count} · hostEvents ${hostEvents}` },
    });
    audit.check({
        name: 'the adapter loaded the checkpoint and wired the attempt context',
        ok: sessionB.store === storeB && sessionB.threadId === 'work:MER-321' && sessionB.loaded === 1
            && Boolean(sessionB.journal) && sessionB.approvals.length === 1
            && sessionB.tools?.[0]?.name === 'tool-MER-321-1',
        detail: {
            expected: 'store attached · threadId work:MER-321 · loaded 1 · journal attached · 1 approval · tool-MER-321-1',
            observed: `store ${sessionB.store === storeB} · threadId ${String(sessionB.threadId)} · loaded ${String(sessionB.loaded)} · journal ${Boolean(sessionB.journal)} · approvals ${sessionB.approvals.length} · tools ${JSON.stringify(sessionB.tools)}`,
        },
    });
    audit.end();

    // ── C: DAG ───────────────────────────────────────────────────────────────
    audit.scenario({
        id: 'C', title: 'DAG: plan, execute, checkpoint, resume',
        goal: 'the real WorkflowExecutor runs the plan returned by planFor and the runner saves a checkpoint even when a step throws',
        expect: 'the first attempt fails on a throwing step and still saves one checkpoint · the second attempt restores, retries the failed step and completes · only the second attempt\'s usage is reported',
        fails: [
            { code: 'no-save', symptom: 'a failed attempt saved no checkpoint', hint: 'the save lives in the execute finally block' },
            { code: 'no-restore', symptom: 'the second attempt did not load the checkpoint', hint: 'resume needs attempt !== null and a store' },
            { code: 'double-usage', symptom: 'the first attempt usage leaked into the second', hint: 'usage is a diff of the executor\'s step totals' },
        ],
        input: { steps: 1, first: 'throws', second: 'completes' },
    });

    const storeC = createStore();
    let failingC = true;
    const clientC = modelClient({
        run: () => {
            if (failingC) throw new Error('the scripted first attempt fails');
            return 'DAG-OK';
        },
    });
    const planC = () => ({
        objective: 'Do the one step',
        context: {},
        steps: [{
            id: 'work',
            title: 'Work',
            systemPrompt: 'Be brief.',
            userPromptTemplate: 'Reply with exactly: DAG-STEP',
            verify: () => ({ passed: true, evidence: 'ok' }),
        }],
    });
    const runnerC = createEngineRunner({ engine: 'dag', client: clientC, model: 'm', store: storeC, planFor: planC });
    const firstC = await runnerC.run(attemptArgs({ attempt: 1 }));
    failingC = false;
    const secondC = await runnerC.run(attemptArgs({ attempt: 2 }));
    const savesC = storeC.calls.filter((entry) => entry.op === 'save').length;
    const loadsC = storeC.calls.filter((entry) => entry.op === 'load').length;
    audit.observe({ name: 'DAG attempts', value: { first: firstC.status, second: secondC.status, saves: savesC, loads: loadsC } });
    audit.check({
        name: 'a failed step still saves, and the resumed attempt completes',
        ok: firstC.status === 'failed' && secondC.status === 'completed' && savesC === 2 && loadsC >= 1,
        detail: {
            expected: 'failed · completed · 2 saves · >= 1 load',
            observed: `${firstC.status} · ${secondC.status} · ${savesC} saves · ${loadsC} loads`,
        },
    });
    audit.check({
        name: 'the resumed attempt reports only its own usage',
        ok: JSON.stringify(secondC.usage) === JSON.stringify({ total_tokens: 4 }),
        detail: { expected: '{"total_tokens":4}', observed: JSON.stringify(secondC.usage) },
    });
    audit.end();

    // ── D: state machine ─────────────────────────────────────────────────────
    audit.scenario({
        id: 'D', title: 'state machine: run the graph and save the checkpoint',
        goal: 'the real StateMachine runs the graphFor graph, reports node progress, and saves its own checkpoint',
        expect: 'the node starts and ends (progress >= 2) · the run completes · one STATE_MACHINE checkpoint is saved · the graph is the one graphFor returned',
        fails: [
            { code: 'no-graph', symptom: 'graphFor was not called', hint: 'the adapter calls graphFor({ item, attempt }) before construction' },
            { code: 'no-save', symptom: 'no checkpoint was saved', hint: 'the save is best effort in a finally, but the store is healthy here' },
            { code: 'no-progress', symptom: 'progress stayed 0', hint: 'NODE_START/NODE_END refresh progress' },
        ],
        input: { nodes: 1, terminal: true },
    });

    const storeD = createStore();
    const graphD = {
        entry: 'only',
        nodes: [{ id: 'only', model: 'm', terminal: true, systemPrompt: 'Be brief.', userPromptTemplate: 'Reply with exactly: SM-NODE' }],
        edges: [],
    };
    const argsD = attemptArgs({ attempt: null });
    const resultD = await createEngineRunner({
        engine: 'stateMachine',
        client: modelClient(),
        model: 'm',
        store: storeD,
        graphFor: () => graphD,
    }).run(argsD);
    const saveD = storeD.calls.find((entry) => entry.op === 'save');
    audit.observe({ name: 'state machine', value: { status: resultD.status, progress: argsD.progress.count, checkpoint: /** @type {any} */ (saveD?.data)?.checkpoint?.kind } });
    audit.check({
        name: 'the graph ran, refreshed progress, and saved its checkpoint',
        ok: resultD.status === 'completed' && argsD.progress.count >= 2
            && saveD !== undefined && /** @type {any} */ (saveD.data).checkpoint.kind === 'stateMachine',
        detail: {
            expected: 'completed · progress >= 2 · checkpoint kind state_machine',
            observed: `${resultD.status} · progress ${argsD.progress.count} · kind ${String(/** @type {any} */ (saveD?.data)?.checkpoint?.kind)}`,
        },
    });
    audit.end();

    // ── E: discussion ────────────────────────────────────────────────────────
    audit.scenario({
        id: 'E', title: 'discussion: the verdict decides the status',
        goal: 'the real DiscussionSession runs function agents, and the judge verdict maps to the runner status',
        expect: 'accepted true completes · accepted false fails · both report usage · no checkpoint is written (the engine has none)',
        fails: [
            { code: 'always-completes', symptom: 'a rejected verdict completed', hint: 'status is completed only when outcome.accepted is true' },
            { code: 'no-usage', symptom: 'usage.total_tokens is 0', hint: 'the judge usage is reported' },
            { code: 'checkpoint', symptom: 'a checkpoint was written', hint: 'the discussion engine has no checkpoint' },
        ],
        input: { agents: 1, verdicts: [true, false] },
    });

    const agents = [{ name: 'analyst', execute: async () => 'the analyst contribution' }];
    const accepted = await createEngineRunner({ engine: 'discussion', client: judgeClient(true), model: 'm', agents, objective: 'decide' })
        .run(attemptArgs({ attempt: null }));
    const rejected = await createEngineRunner({ engine: 'discussion', client: judgeClient(false), model: 'm', agents, objective: 'decide' })
        .run(attemptArgs({ attempt: null }));
    audit.observe({ name: 'discussion', value: { accepted: accepted.status, rejected: rejected.status, usage: accepted.usage } });
    audit.check({
        name: 'the verdict decides completed versus failed',
        ok: accepted.status === 'completed' && rejected.status === 'failed',
        detail: { expected: 'accepted completed · rejected failed', observed: `${accepted.status} · ${rejected.status}` },
    });
    audit.check({
        name: 'both runs report the judge usage',
        ok: Number(/** @type {any} */ (accepted.usage)?.total_tokens) > 0
            && Number(/** @type {any} */ (rejected.usage)?.total_tokens) > 0,
        detail: { expected: '> 0 tokens on both', observed: `${JSON.stringify(accepted.usage)} · ${JSON.stringify(rejected.usage)}` },
    });
    audit.end();

    // ── F: live ──────────────────────────────────────────────────────────────
    audit.scenario({
        id: 'F', title: 'the four adapters against the real backend',
        goal: 'the same factory drives a real agentic turn, a real DAG step, a real state-machine node and a real discussion',
        expect: 'agentic summary contains LIVE-RUNNER-AGENTIC · the DAG summary contains LIVE-RUNNER-DAG · the state-machine summary contains LIVE-RUNNER-SM · the discussion returns a typed status with a non-empty summary · > 0 api_request',
        fails: [
            { code: 'no-call', symptom: 'apiCalls is 0', hint: 'live mode needs a backend and credentials in secret.env' },
            { code: 'no-marker', symptom: 'an engine summary lacks its forced marker', hint: 'each prompt forces an exact token; free prose is not proof' },
            { code: 'engine-mismatch', symptom: 'an engine returned the wrong status', hint: 'inspect the adapter for that engine' },
        ],
        input: { model: live?.toolModel ?? '(offline)', engines: 4 },
    });

    if (live !== null && client !== null) {
        const liveArgs = () => attemptArgs({ identifier: 'MER-32L', attempt: null });
        const liveClient = /** @type {any} */ (client);

        const agenticLive = await createEngineRunner({
            engine: 'agentic',
            client: liveClient,
            model: live.toolModel,
            prompt: 'Reply with exactly: LIVE-RUNNER-AGENTIC',
        }).run(liveArgs());

        const dagLive = await createEngineRunner({
            engine: 'dag',
            client: liveClient,
            model: live.toolModel,
            planFor: async () => ({
                objective: 'Do the one live step',
                context: {},
                steps: [{ id: 'work', title: 'Work', systemPrompt: 'Be brief.', userPromptTemplate: 'Reply with exactly: LIVE-RUNNER-DAG' }],
            }),
        }).run(liveArgs());

        const smLive = await createEngineRunner({
            engine: 'stateMachine',
            client: liveClient,
            model: live.toolModel,
            graphFor: () => ({
                entry: 'only',
                nodes: [{ id: 'only', model: live.toolModel, terminal: true, systemPrompt: 'Be brief.', userPromptTemplate: 'Reply with exactly: LIVE-RUNNER-SM' }],
                edges: [],
            }),
        }).run(liveArgs());

        const discussionLive = await createEngineRunner({
            engine: 'discussion',
            client: liveClient,
            model: live.toolModel,
            agents: [{ name: 'analyst', persona: 'You are a one-line analyst.', model: live.toolModel, provider: live.provider }],
            objective: 'State one condition for shipping on Friday.',
        }).run(liveArgs());

        audit.observe({
            name: 'live results',
            value: {
                agentic: [agenticLive.status, String(agenticLive.summary ?? '').slice(0, 80)],
                dag: [dagLive.status, String(dagLive.summary ?? '').slice(0, 80)],
                stateMachine: [smLive.status, String(smLive.summary ?? '').slice(0, 80)],
                discussion: [discussionLive.status, String(discussionLive.summary ?? '').slice(0, 80)],
                apiCalls,
            },
        });
        audit.check({
            name: 'agentic ran a real turn and returned its marker',
            ok: agenticLive.status === 'completed' && String(agenticLive.summary ?? '').includes('LIVE-RUNNER-AGENTIC'),
            detail: { expected: 'completed · summary contains LIVE-RUNNER-AGENTIC', observed: `${agenticLive.status} · ${String(agenticLive.summary ?? '')}` },
        });
        audit.check({
            name: 'the DAG executor ran a real step and returned its marker',
            ok: dagLive.status === 'completed' && String(dagLive.summary ?? '').includes('LIVE-RUNNER-DAG'),
            detail: { expected: 'completed · summary contains LIVE-RUNNER-DAG', observed: `${dagLive.status} · ${String(dagLive.summary ?? '')}` },
        });
        audit.check({
            name: 'the state machine ran a real node and returned its marker',
            ok: smLive.status === 'completed' && String(smLive.summary ?? '').includes('LIVE-RUNNER-SM'),
            detail: { expected: 'completed · summary contains LIVE-RUNNER-SM', observed: `${smLive.status} · ${String(smLive.summary ?? '')}` },
        });
        audit.check({
            name: 'the discussion engine produced an accepted verdict from a real model',
            ok: discussionLive.status === 'completed' && String(discussionLive.summary ?? '').trim().length > 0,
            detail: { expected: 'completed · non-empty summary', observed: `${discussionLive.status} · ${String(discussionLive.summary ?? '').slice(0, 120)}` },
        });
        audit.check({
            name: 'every live engine made a real vendor call',
            ok: apiCalls > 0,
            detail: { expected: '> 0 api_request', observed: `${apiCalls} api_request` },
        });
        if (usage !== null) reportUsage({ provider: live.provider, usage });
    }
    audit.end();

    log.success({ m: 'Engine runner verified: selection, four adapters, checkpoints, usage, and live runs.' });
}

// The await matters: without it a stalled round would exit 0 with a truncated log.
await audit.run(main);
