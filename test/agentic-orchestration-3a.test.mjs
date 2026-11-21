// @ts-check
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isSafeHttpUrl, urlPermitted, splitUrlsByDomainPolicy } from '../lib/agentic/web-shared.mjs';
import { CurlEngine, TavilyExtractEngine } from '../lib/agentic/webscrape/engines.mjs';
import { WebScrapeComponent } from '../lib/agentic/webscrape/component.mjs';
import { WebSearchComponent } from '../lib/agentic/websearch/component.mjs';

/** A public DNS answer, so these tests never depend on real DNS. */
const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

/** @param {{input: any, opts?: any}} arg0 */
const curlFetch = ({ input, opts = {} }) => CurlEngine.fetch.call(CurlEngine, { input, opts: { ...opts, lookup: PUBLIC_LOOKUP, fetch: global.fetch } });
import { BrowserComponent } from '../lib/agentic/browser/component.mjs';
import { PlaywrightSession } from '../lib/agentic/browser/engines.mjs';
import { BaseChatSession } from '../lib/agentic/chat-session.mjs';
import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { discoverInstructions } from '../lib/agentic/context.mjs';
import { objectiveProgressDigest } from '../lib/agentic/objective.mjs';
import { createTaskTool, withTaskAgents } from '../lib/agentic/task.mjs';
import { compactHistory, adjustCutForToolPairs, runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { runStep } from '../lib/agentic/step.mjs';
import { ApprovalCoordinator } from '../lib/agentic/planning/approval.mjs';
import { StateMachine, compileCondition } from '../lib/agentic/state-machine/machine.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { getLeafOutput } from '../lib/agentic/planning/graph-utils.mjs';
import { structuredLlmCall } from '../lib/agentic/planning/planner-utils.mjs';
import { LocalFileMemoryProvider } from '../lib/agentic/memory/providers.mjs';
import { MemoryManager } from '../lib/agentic/memory/manager.mjs';
import { TodoComponent } from '../lib/agentic/todos/component.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { createSaveArtifactTool } from '../lib/agentic/artifacts.mjs';
import { LocalFileSessionStore } from '../lib/agentic/sessions.mjs';
import { createHooks, HOOKS, STOP } from '../lib/core/hooks.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { ConfigurationError, BackendError, AbortedError, BudgetExceededError, OrchestrationExhaustedError } from '../lib/core/errors.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

// ── 1. Web / Browser SSRF Guard, Redirect Cleanup & Scrape Bounds ──────────

test('1a: isSafeHttpUrl, urlPermitted and splitUrlsByDomainPolicy block private/reserved/non-http URLs even without domain lists', () => {
    const blocked = [
        'file:///etc/passwd',
        'data:text/html,<h1>x</h1>',
        'javascript:alert(1)',
        'ftp://example.com/file',
        'http://localhost/admin',
        'http://sub.localhost:8080/x',
        'http://127.0.0.1/',
        'http://127.1.2.3/',
        'http://0.0.0.0/',
        'http://10.0.0.1/',
        'http://172.16.0.1/',
        'http://172.31.255.255/',
        'http://192.168.1.1/',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/',
        'http://[fe80::1]/',
        'http://[fc00::1]/',
        'http://[fd00::1]/',
        'http://[::ffff:127.0.0.1]/',
        'http://metadata.google.internal/computeMetadata/v1/',
    ];
    for (const url of blocked) {
        assert.equal(isSafeHttpUrl({ url }), false, `isSafeHttpUrl should reject ${url}`);
        assert.equal(urlPermitted({ url }), false, `urlPermitted should reject ${url}`);
    }
    assert.equal(isSafeHttpUrl({ url: 'http://127.0.0.1/', allowPrivateNetwork: true }), true);
    assert.equal(isSafeHttpUrl({ url: 'https://172.15.0.1/' }), true);
    assert.equal(isSafeHttpUrl({ url: 'https://172.32.0.1/' }), true);
    assert.equal(isSafeHttpUrl({ url: 'https://example.com/path' }), true);

    const split = splitUrlsByDomainPolicy({
        urls: ['https://example.com/a', 'http://169.254.169.254/meta', 'http://localhost:3000'],
        allowedDomains: [],
        blockedDomains: [],
    });
    assert.deepEqual(split.permitted, ['https://example.com/a']);
    assert.deepEqual(split.denied, ['http://169.254.169.254/meta', 'http://localhost:3000']);
});

test('1b: PlaywrightSession & BrowserComponent block SSRF before goto and reset page on blocked redirect', async () => {
    /** @type {string[]} */
    const visited = [];
    let currentUrl = 'about:blank';
    const page = {
        url: () => currentUrl,
        title: async () => 'Title',
        goto: async (/** @type {string} */ u) => {
            visited.push(u);
            currentUrl = u === 'https://ok.example/redirect' ? 'http://169.254.169.254/secret' : u;
        },
        close: async () => {},
        evaluate: async () => ({ text: currentUrl === 'about:blank' ? '' : 'SECRET_BODY', elements: [] }),
        on: () => {},
    };
    const connect = async () => ({
        newContext: async () => ({ newPage: async () => page }),
        close: async () => {},
    });

    const pw = new PlaywrightSession({ opts: { connect: /** @type {any} */ (connect) } });
    await assert.rejects(
        () => pw.act({ action: 'navigate', p: { url: 'http://127.0.0.1:8080/admin' } }),
        BackendError
    );
    assert.deepEqual(visited, [], 'blocked URL must never reach page.goto');

    const comp = new BrowserComponent({
        provider: 'openai',
        config: { mode: 'playwright', playwright: { connect } },
    });
    await assert.rejects(
        () => comp.load({ action: 'navigate', url: 'https://ok.example/redirect' }),
        ConfigurationError
    );
    assert.equal(currentUrl, 'about:blank', 'blocked post-redirect page must be navigated to about:blank');
    const snap = JSON.parse(await comp.load({ action: 'snapshot' }));
    assert.equal(snap.url, 'about:blank');
    assert.equal(snap.bodyText, '');
});

test('1c: WebScrapeComponent forwards args.maxChars and args.timeoutMs, and TavilyExtractEngine truncates to maxChars', async () => {
    const orig = global.fetch;
    /** @type {any} */
    let capturedBody = null;
    global.fetch = /** @type {any} */ (async (/** @type {any} */ _url, /** @type {any} */ opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({
                results: [{ url: 'https://example.com', raw_content: '0123456789ABCDEF' }],
            }),
        };
    });
    try {
        const comp = new WebScrapeComponent({
            provider: 'openai',
            config: { mode: 'tavily', maxChars: 20000, timeoutMs: 30000, tavily: { apiKey: 'k' } },
        });
        const out = JSON.parse(await comp.load({ url: 'https://example.com', maxChars: 6, timeoutMs: 4000 }));
        assert.equal(capturedBody.timeout, 4);
        assert.equal(out.results[0].content, '012345');
        assert.equal(out.results[0].truncated, true);
    } finally {
        global.fetch = orig;
    }

    const [curlOut] = await curlFetch({ input: 'http://127.0.0.1/secret' });
    assert.match(/** @type {any} */ (curlOut).error, /domain policy/);
});

test('1d: WebSearchComponent defaults cacheTtlMs to 300_000 and bounds _cache at 256 entries (FIFO)', async () => {
    const orig = global.fetch;
    global.fetch = /** @type {any} */ (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ answer: 'ok', results: [] }),
    }));
    try {
        const comp = new WebSearchComponent({
            provider: 'openai',
            config: { mode: 'tool', tavily: { apiKey: 'k' } },
        });
        for (let i = 0; i < 260; i++) {
            await comp.load({ query: `q-${i}` });
        }
        assert.equal(comp._cache.size, 256);
        const keys = [...comp._cache.keys()];
        assert.ok(!keys[0].includes('\u0000q-0\u0000'), 'oldest keys evicted FIFO');
        assert.ok(keys[0].includes('\u0000q-4\u0000'));
    } finally {
        global.fetch = orig;
    }
});

// ── 2. Hook Veto, Session ID, Capability Reconfig, Context & Objective ─────

test('2a: HOOKS.REQUEST_BEFORE returning STOP short-circuits before executeVendorRequest; requestSignal & stream error status', async () => {
    let vendorCalled = false;
    /** @type {AbortSignal|null} */
    let seenConsumeSignal = null;
    const adapter = {
        vendorName: 'STUB',
        buildVendorRequest: () => ({ request: { ok: 1 }, observability: { model: 'm' } }),
        executeVendorRequest: () => { vendorCalled = true; return {}; },
        consumeStream: async function* (/** @type {any} */ { signal }) {
            seenConsumeSignal = signal;
            yield { type: EVENTS.CLIENT.ERROR, error_type: 'rate_limit', error_message: 'slow down' };
        },
        extractXmlToolCalls: () => [],
        formatToolCall: (/** @type {any} */ { call }) => ({ id: call.id, name: call.name, args: {} }),
    };
    const emitter = new EventEmitter();
    const session = new (class extends BaseChatSession {})({
        vendorClient: {},
        model: 'm',
        eventEmitter: emitter,
        provider: ProviderType.OPENAI,
        adapter,
        buildParameters: (/** @type {any} */ { spec }) => spec,
    });
    session._onStepShouldPrepare = () => false;

    const hooks = createHooks();
    hooks.add({ name: HOOKS.REQUEST_BEFORE, fn: () => STOP });
    session.withHooks({ hooks });

    const gen = session.step({ messages: [] });
    const first = await gen.next();
    assert.equal(first.done, true);
    assert.equal(/** @type {any} */ (first.value).vetoed, true);
    assert.equal(vendorCalled, false, 'vendor must not be called when REQUEST_BEFORE vetoes with STOP');

    hooks.clear();
    session.withTimeout({ timeout: { totalMs: 5000 } });
    /** @type {any[]} */
    const streamEnds = [];
    emitter.on(EVENTS.CLIENT.API_STREAM_END, (e) => streamEnds.push(e));
    const gen2 = session.step({ messages: [] });
    while (!(await gen2.next()).done) { /* drain */ }
    assert.ok(seenConsumeSignal, 'requestSignal passed to consumeStream');
    assert.equal(streamEnds.length, 1);
    assert.equal(streamEnds[0].status, 'error', 'API_STREAM_END reports error when EVENTS.CLIENT.ERROR is yielded');
});

test('2b: ChatSessionBuilder withSessionId updates _sessionRunCtx, _attachWebCap cleans up stale tool, saveCheckpoint defaults messages to []', async () => {
    const adapter = {
        vendorName: 'STUB',
        buildVendorRequest: () => ({ request: {}, observability: {} }),
        executeVendorRequest: () => ({}),
        consumeStream: async function* () {},
        extractXmlToolCalls: () => [],
        formatToolCall: () => ({}),
    };
    const session = new (class extends BaseChatSession {})({
        vendorClient: {},
        model: 'm',
        eventEmitter: new EventEmitter(),
        provider: ProviderType.ANTHROPIC,
        adapter,
        buildParameters: (/** @type {any} */ { spec }) => spec,
    });

    session.withSessionId({ id: 'custom-session-123' });
    assert.equal(session.sessionId, 'custom-session-123');
    assert.equal(session._sessionRunCtx.sessionId, 'custom-session-123');

    session.withWebSearch({ options: { mode: 'tavily' } });
    assert.ok(session._tools.some((t) => t.name === 'web_search'), 'tavily mode registers web_search tool');
    session.withWebSearch({ options: { mode: 'native' } });
    assert.ok(!session._tools.some((t) => t.name === 'web_search'), 'switching to native removes stale web_search tool');

    /** @type {any} */
    let savedData = null;
    session.withSessionStore({
        store: /** @type {any} */ ({
            save: async (/** @type {any} */ { data }) => { savedData = data; return '/tmp/cp.json'; },
        }),
        threadId: 't1',
    });
    await session.saveCheckpoint();
    assert.deepEqual(savedData.messages, []);
});

test('2c: discoverInstructions skips symlinked AGENTS.md outside boundary and files > 256KB', async () => {
    const base = await fs.mkdtemp(join(tmpdir(), 'merci-ctx-'));
    const ws = join(base, 'workspace');
    const outside = join(base, 'outside-secret.md');
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(outside, 'TOP_SECRET_OUTSIDE_WORKSPACE', 'utf8');
    const agentsPath = join(ws, 'AGENTS.md');
    await fs.symlink(outside, agentsPath);

    try {
        const res1 = await discoverInstructions({ root: ws, stopAt: ws });
        assert.equal(res1, null, 'symlink outside stopAt boundary must be skipped');

        await fs.unlink(agentsPath);
        await fs.writeFile(agentsPath, 'x'.repeat(256 * 1024 + 10), 'utf8');
        const res2 = await discoverInstructions({ root: ws, stopAt: ws });
        assert.equal(res2, null, 'AGENTS.md > 256KB must be skipped');

        await fs.writeFile(agentsPath, 'Valid workspace rule', 'utf8');
        const res3 = await discoverInstructions({ root: ws, stopAt: ws });
        assert.match(String(res3), /Valid workspace rule/);
    } finally {
        await fs.rm(base, { recursive: true, force: true });
    }
});

test('2d: objectiveProgressDigest ignores GAI functionResponse tool-result rows', () => {
    const digest = objectiveProgressDigest({
        messages: [
            { role: 'user', content: 'Real user goal' },
            { role: 'user', parts: [{ functionResponse: { name: 'tool', response: { secret: 'TOOL_NOISE' } } }], content: 'TOOL_NOISE' },
            { role: 'user', functionResponse: { name: 'tool', response: {} }, content: 'MORE_TOOL_NOISE' },
            { role: 'assistant', content: 'Done step 1' },
        ],
    });
    assert.ok(digest.includes('Real user goal'));
    assert.ok(!digest.includes('TOOL_NOISE'), 'GAI functionResponse rows must not be treated as user turns');
});

// ── 3. Hedge Ladder, Single-Turn Compaction & Live Task Fork Context ───────

test('3a: runWithHedge waits for surviving attempt when the other attempt rejects after hedge starts', async () => {
    let calls = 0;
    const emitter = new EventEmitter();
    const client = /** @type {any} */ ({
        provider: 'openai',
        session: () => {
            const idx = ++calls;
            return {
                provider: 'openai',
                model: 'm',
                eventEmitter: emitter,
                withSystemMessage() { return this; },
                withTools() { return this; },
                withCircuitBreaker() { return this; },
                async run() {
                    if (idx === 1) {
                        await new Promise((r) => setTimeout(r, 40));
                        throw new Error('attempt 1 failed after hedge started');
                    }
                    await new Promise((r) => setTimeout(r, 70));
                    return 'attempt 2 succeeded';
                },
            };
        },
    });
    withTaskAgents({
        client,
        agents: [{ name: 'worker', model: 'm', hedgeAfterMs: 15 }],
    });
    const parentSession = /** @type {any} */ ({
        client,
        model: 'm',
        provider: 'openai',
        eventEmitter: emitter,
    });
    const tool = /** @type {any} */ (createTaskTool({ session: parentSession }));
    const res = await tool.execute({ args: { prompt: 'go', subagent_type: 'worker' } });
    assert.equal(res, 'attempt 2 succeeded');
    assert.equal(calls, 2);
});

test('3b: compactHistory compacts single-turn long tool loops while keeping tool pairs intact', async () => {
    /** @type {any[]} */
    const messages = [
        createUserMessage({ provider: 'OAI', content: 'Initial user task' }),
    ];
    for (let i = 1; i <= 6; i++) {
        messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [{ id: `c_${i}`, type: 'function', function: { name: 'work', arguments: JSON.stringify({ step: i, pad: 'x'.repeat(40) }) } }],
        });
        messages.push({
            role: 'tool',
            tool_call_id: `c_${i}`,
            name: 'work',
            content: `result_${i}_${'y'.repeat(40)}`,
        });
    }

    const cut = adjustCutForToolPairs({ messages, cut: messages.length - 3, minCut: 2 });
    assert.equal(messages[cut].role, 'assistant', 'cut must land on assistant tool_call, never on a tool result');

    const compacted = await compactHistory({
        messages,
        compaction: {
            thresholdTokens: 10,
            keepRecent: 4,
            summarize: async (/** @type {any[]} */ prefix) => `Summarized ${prefix.length} intermediate messages`,
        },
        session: { eventEmitter: new EventEmitter() },
        signal: null,
        onEvent: null,
    });

    assert.ok(compacted.length < messages.length, 'single-turn long loop must be compacted');
    assert.equal(compacted[0].role, 'system');
    assert.equal(compacted[1].content, 'Initial user task', 'initial user turn is preserved');
    assert.equal(compacted[2].role, 'assistant', 'tail starts cleanly at an assistant tool_call');
});

test('3c: first-turn task delegation with context:"fork" sees current turn messages, and handoff.tools:"none" strips task tool', async () => {
    /** @type {any[]} */
    let childReceivedMessages = [];
    const emitter = new EventEmitter();
    const client = /** @type {any} */ ({
        provider: 'OAI',
        session: () => {
            const s = new ChatSessionBuilder();
            s.provider = 'OAI';
            s.model = 'm';
            s.client = client;
            s.eventEmitter = emitter;
            s.run = async (/** @type {any} */ { initialInput }) => {
                childReceivedMessages = initialInput;
                return 'child done';
            };
            return s;
        },
    });
    withTaskAgents({
        client,
        agents: [{ name: 'forker', model: 'm', handoff: { context: 'fork', tools: 'none' } }],
    });

    const parent = new ChatSessionBuilder();
    parent.provider = 'OAI';
    parent.model = 'm';
    parent.client = client;
    parent.eventEmitter = emitter;
    let stepCount = 0;
    /**
     * @param {{messages: any[]}} arg0
     * @returns {AsyncGenerator<any, any, any>}
     */
    async function* parentStep({ messages }) {
        stepCount++;
        if (stepCount === 1) {
            const results = yield {
                type: 'tool_request',
                calls: [{ id: 'tc_1', name: 'task', arguments: JSON.stringify({ prompt: 'sub-work', subagent_type: 'forker', handoff: { context: 'fork', tools: 'none' } }) }],
            };
            return { done: false, content: '', messages: [...messages, { role: 'tool', content: results?.[0]?.result ?? '' }] };
        }
        return { done: true, content: 'all done', messages };
    }
    (/** @type {any} */ (parent)).step = parentStep;

    const final = await runAgenticLoop({
        session: /** @type {any} */ (parent),
        messages: [createUserMessage({ provider: 'OAI', content: 'First turn user prompt' })],
    });
    assert.equal(final, 'all done');
    assert.ok(childReceivedMessages.some((m) => m.content === 'First turn user prompt'), 'forked child must see the first turn user prompt');

    /** @type {any[]} */
    let exposedTools = [];
    const stepSession = new ChatSessionBuilder();
    stepSession.provider = 'OAI';
    stepSession.model = 'm';
    stepSession.client = client;
    stepSession.eventEmitter = emitter;
    stepSession.run = async () => {
        exposedTools = stepSession._tools;
        return 'ok';
    };
    await runStep({
        step: { id: 's1', handoff: { tools: 'none' } },
        deps: { client, model: 'm', session: stepSession, handoff: { tools: 'none' }, userText: 'hi' },
    });
    assert.deepEqual(exposedTools, [], 'handoff.tools: "none" must not leak the built-in task tool');
});

// ── 4. ApprovalCoordinator, StateMachine, WorkflowExecutor, Memory, Todos, Discussion, Artifacts ──

test('4a: ApprovalCoordinator resets _timedOut on subsequent wait()', async () => {
    const coord = new ApprovalCoordinator({ timeoutMs: 15 });
    const first = await coord.wait();
    assert.equal(first.approved, false);
    assert.equal(coord.timedOut, true);

    const secondPromise = coord.wait();
    assert.equal(coord.timedOut, false);
    coord.resolve({ approved: true, details: { note: 'approved on retry' } });
    const second = await secondPromise;
    assert.equal(second.approved, true);
    assert.equal(second.note, 'approved on retry');
});

test('4b: StateMachine addEdge compiles string & rejects async conditions; plan resets state; save/load handles circular ctx & running phase', async () => {
    const sm = new StateMachine({
        graph: {
            entry: 'a',
            nodes: [
                { id: 'a', execute: (/** @type {any} */ ctx) => { ctx.set({ k: 'n', v: 5 }); return 'a'; } },
                { id: 'b', execute: () => 'b', terminal: true },
            ],
            edges: [],
        },
    });
    sm.addEdge({ edgeDef: { from: 'a', to: 'b', condition: "ctx.get('n') === 5" } });
    assert.equal(typeof sm.graph.edges[0].condition, 'function');
    assert.throws(
        () => sm.addEdge({ edgeDef: { from: 'a', to: 'b', condition: async () => true } }),
        ConfigurationError
    );
    assert.throws(
        () => compileCondition({ expr: async () => true }),
        ConfigurationError
    );

    const smThenable = new StateMachine({
        graph: {
            entry: 'a',
            nodes: [
                { id: 'a', execute: () => 'a' },
                { id: 'b', execute: () => 'b', terminal: true },
            ],
            edges: [{ from: 'a', to: 'b', condition: () => Promise.resolve(false) }],
        },
    });
    await assert.rejects(() => smThenable.run(), ConfigurationError);

    let midCheckpoint = '';
    const circular = /** @type {any} */ ({ name: 'loop' });
    circular.self = circular;
    const smMid = new StateMachine({
        graph: {
            entry: 'a',
            nodes: [
                {
                    id: 'a',
                    execute: (/** @type {any} */ ctx, /** @type {any} */ { machine }) => {
                        ctx.set({ k: 'circ', v: circular });
                        midCheckpoint = machine.save();
                        return 'done-a';
                    },
                    terminal: true,
                },
            ],
            edges: [],
        },
    });
    await smMid.run();
    const restored = StateMachine.load({
        json: midCheckpoint,
        graph: {
            entry: 'a',
            nodes: [{ id: 'a', execute: () => 'resumed-ok', terminal: true }],
            edges: [],
        },
    });
    assert.equal(restored.phase, 'idle', 'mid-run checkpoint must normalize phase from running to idle');
    await restored.run();
    assert.equal(restored.phase, 'done');
});

test('4c: WorkflowExecutor setSteps validates ids & cycles before mutation, aborts timed-out steps, chains nested HITL prefixes, and avoids duplicate decline on timeout', async () => {
    const exec = new WorkflowExecutor({ options: { defaultModel: 'm' } });
    exec.setSteps({ stepsList: [{ id: 'valid', userPromptTemplate: 'ok', dependencies: [] }] });

    assert.throws(
        () => exec.setSteps({ stepsList: [/** @type {any} */ ({ id: '   ', userPromptTemplate: 'x' })] }),
        ConfigurationError
    );
    assert.throws(
        () => exec.setSteps({
            stepsList: [
                { id: 'c1', dependencies: ['c2'] },
                { id: 'c2', dependencies: ['c1'] },
            ],
        }),
        ConfigurationError
    );
    assert.deepEqual([...exec.steps.keys()], ['valid'], 'failed setSteps must not mutate existing steps');

    let stepSignalAborted = false;
    const timeoutExec = new WorkflowExecutor({
        options: {
            defaultModel: 'm',
            stepTimeoutMs: 25,
            client: {
                session: () => ({
                    provider: 'openai',
                    withSystemMessage() { return this; },
                    withCircuitBreaker() { return this; },
                    run: (/** @type {any} */ { options }) => new Promise((_resolve, reject) => {
                        options.signal?.addEventListener('abort', () => {
                            stepSignalAborted = true;
                            reject(new AbortedError({ message: 'step aborted' }));
                        });
                    }),
                }),
            },
        },
    });
    timeoutExec.setSteps({ stepsList: [{ id: 'slow', userPromptTemplate: 'wait', dependencies: [] }] });
    await assert.rejects(() => timeoutExec.execute({ userGoal: 'test timeout' }));
    assert.equal(stepSignalAborted, true, 'step timeout must abort the child AbortController signal');

    /** @type {string[]} */
    const gateEvents = [];
    const hitlTimeoutExec = new WorkflowExecutor({
        options: {
            defaultModel: 'm',
            hitlTimeoutMs: 15,
            client: { session: () => ({ provider: 'openai', withSystemMessage() { return this; }, run: async () => 'ok' }) },
        },
    });
    hitlTimeoutExec.on(EVENTS.WORKFLOW.HITL_PENDING, () => {});
    hitlTimeoutExec.on(EVENTS.WORKFLOW.HITL_TIMEOUT, () => gateEvents.push('timeout'));
    hitlTimeoutExec.on(EVENTS.WORKFLOW.HITL_DECLINED, () => gateEvents.push('declined'));
    hitlTimeoutExec.on(EVENTS.WORKFLOW.STEP_GATE_REJECTED, () => gateEvents.push('rejected'));
    hitlTimeoutExec.setSteps({ stepsList: [{ id: 'g', userPromptTemplate: 'x', hitl: true }] });
    await assert.rejects(() => hitlTimeoutExec.execute({ userGoal: 'hitl timeout' }));
    assert.deepEqual(gateEvents, ['timeout', 'rejected'], 'timeout must not emit a duplicate HITL_DECLINED + STEP_GATE_REJECTED');

    /** @type {string[]} */
    const seenApprovalIds = [];
    const rootExec = new WorkflowExecutor({
        options: {
            defaultModel: 'm',
            maxDepth: 3,
            client: {
                session: () => ({
                    provider: 'openai',
                    withSystemMessage() { return this; },
                    withCircuitBreaker() { return this; },
                    run: async () => 'deep-ok',
                }),
            },
        },
    });
    rootExec.on(EVENTS.WORKFLOW.HITL_PENDING, (e) => {
        seenApprovalIds.push(e.approvalId);
        const resolved = rootExec.resolveApproval({ approvalId: e.approvalId, approved: true });
        assert.equal(resolved, true, `root executor must route nested approvalId ${e.approvalId}`);
    });
    rootExec.setSteps({
        stepsList: [{
            id: 'lvl1',
            engine: 'dag',
            subSteps: [{
                id: 'lvl2',
                engine: 'dag',
                subSteps: [{
                    id: 'leaf',
                    userPromptTemplate: 'go',
                    hitl: true,
                }],
            }],
        }],
    });
    const nestedOut = /** @type {any} */ (await rootExec.execute({ userGoal: 'deep nested hitl' }));
    assert.deepEqual(seenApprovalIds, ['lvl1:lvl2:approval_0']);
    assert.equal(nestedOut.lvl1.output, 'deep-ok');
});

test('4d: getLeafOutput preserves 0, false, and objects with { error: "none" }; runToolCapture bounds repair loop', async () => {
    const steps = new Map([['s1', { id: 's1', dependencies: [] }]]);
    assert.equal(getLeafOutput({ stepsMap: steps, outputs: { s1: { output: 0, data: 0 } } }).output, 0);
    assert.equal(getLeafOutput({ stepsMap: steps, outputs: { s1: { output: false, data: false } } }).output, false);
    const benignErrObj = { error: 'none', result: 42 };
    assert.deepEqual(
        getLeafOutput({ stepsMap: steps, outputs: { s1: { output: benignErrObj, data: benignErrObj } } }).output,
        benignErrObj
    );

    let stepNextCalls = 0;
    const badClient = {
        provider: ProviderType.OPENCODE,
        session: () => ({
            provider: ProviderType.OPENCODE,
            withSystemMessage() { return this; },
            withParameters() { return this; },
            withTools() { return this; },
            async *step() {
                for (;;) {
                    stepNextCalls++;
                    yield {
                        type: 'tool_request',
                        calls: [{ id: `c_${stepNextCalls}`, name: 'plan', arguments: '{"wrong":1}' }],
                    };
                }
            },
        }),
    };
    await assert.rejects(
        () => structuredLlmCall({
            client: badClient,
            model: 'm',
            systemMessage: 'sys',
            schema: { type: 'object', properties: { requiredField: { type: 'string' } }, required: ['requiredField'], additionalProperties: false },
            prompt: 'go',
            maxAttempts: 1,
        }),
        OrchestrationExhaustedError
    );
    assert.equal(stepNextCalls, 4, 'initial call + 3 bounded repairs = 4 tool_request yields');
});

test('4e: LocalFileMemoryProvider coalesces concurrent load(), MemoryManager stores before delete, TodoComponent serializes _persist()', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'merci-mem-todo-'));
    try {
        const memFile = join(dir, 'mem.json');
        await fs.writeFile(memFile, JSON.stringify({
            version: 1,
            facts: [{ id: 'f1', content: 'seed fact', category: 'general', timestamp: 1 }],
            lastSyncedTurnIndex: 0,
        }), 'utf8');

        const provider = new LocalFileMemoryProvider({ options: { filePath: memFile } });
        const [p1, p2] = [provider.load(), provider.load()];
        await Promise.all([p1, p2]);
        assert.equal(provider.facts.length, 1);

        /** @type {string[]} */
        const order = [];
        const duckProvider = {
            name: 'duck',
            description: 'duck bank',
            facts: [{ id: 'old_1', content: 'old' }],
            lastSyncedTurnIndex: 0,
            getBankDescriptions: () => '- "duck": duck bank\n',
            load: async () => {},
            save: async () => {},
            query: async () => [],
            store: async (/** @type {any} */ { content }) => {
                order.push(`store:${content}`);
                return { id: 'new_1', content, category: 'general' };
            },
            delete: async (/** @type {any} */ { id }) => {
                order.push(`delete:${id}`);
                return true;
            },
        };
        const mgr = new MemoryManager({ provider: duckProvider, options: { syncInterval: 1 } });
        const distillClient = {
            session: () => ({
                withSystemMessage() { return this; },
                withParameters() { return this; },
                run: async () => JSON.stringify({
                    newFacts: [{ content: 'fresh', category: 'general', targetBanks: ['duck'] }],
                    obsoleteFactIds: ['old_1'],
                }),
            }),
        };
        await mgr.distill({
            messages: [{ role: 'user', content: 'turn 1' }],
            client: distillClient,
            modelToUse: 'm',
        });
        assert.deepEqual(order, ['store:fresh', 'delete:old_1'], 'newFacts must be stored before obsoleteFactIds are deleted');

        const todoFile = join(dir, 'todos.json');
        const store = new Map();
        const todoComp = new TodoComponent({ store, filePath: todoFile });
        await Promise.all([
            todoComp.save({ args: { action: 'add', id: '1', title: 'Task 1' } }),
            todoComp.save({ args: { action: 'add', id: '2', title: 'Task 2' } }),
            todoComp.save({ args: { action: 'add', id: '3', title: 'Task 3' } }),
        ]);
        const persisted = JSON.parse(await fs.readFile(todoFile, 'utf8'));
        assert.equal(persisted.tasks.length, 3);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('4f: DiscussionSession rethrows abort in summarize, routes per-agent client in conclude, catches throwing task.verify, returns shallow copy from getLedger; artifacts filters corrupt entries', async () => {
    /** @type {string[]} */
    const clientCalls = [];
    const customClient = {
        provider: 'openai',
        session: () => ({
            provider: 'openai',
            withSystemMessage() { return this; },
            withCircuitBreaker() { return this; },
            run: async () => {
                clientCalls.push('custom');
                return JSON.stringify({ passed: true, score: 95, reason: 'solid', revision: 'minor' });
            },
        }),
    };
    // A DISTINCT group client: with the same object on both sides, "routes through
    // the per-agent client" cannot fail — the group's own client is a valid answer.
    /** @type {string[]} */
    const groupCalls = [];
    const groupClient = {
        provider: 'openai',
        session: () => ({
            provider: 'openai',
            withSystemMessage() { return this; },
            withCircuitBreaker() { return this; },
            run: async () => {
                groupCalls.push('group');
                return JSON.stringify({ passed: true, score: 95, reason: 'solid', revision: 'minor' });
            },
        }),
    };
    // The roster lives on the GROUP client (that is where `runTasks` resolves a
    // profile); the model turns must still route through the agent's own client.
    withTaskAgents({ client: /** @type {any} */ (groupClient), agents: [{ name: 'worker', execute: async () => 'subagent output' }] });

    const group = new DiscussionSession({ client: /** @type {any} */ (groupClient) });
    group.addAgent({ name: 'A', model: 'm', client: customClient });

    const ac = new AbortController();
    ac.abort(new Error('abort-sum'));
    await assert.rejects(
        () => group.discuss({
            instruction: 'hi',
            tail: 1,
            summarize: async () => { throw new AbortedError({ message: 'aborted inside summarizer' }); },
            signal: ac.signal,
        }),
        AbortedError
    );

    await group.runTasks({
        tasks: [{
            title: 't1',
            description: 'do work',
            subagent_type: 'worker',
            verify: async () => { throw new Error('verify exploded'); },
        }],
    });
    const ledgerCopy = /** @type {any[]} */ (group.getLedger());
    assert.equal(ledgerCopy.length, 1);
    assert.match(ledgerCopy[0].content, /\[error:.*verify exploded/);
    ledgerCopy.push({ author: 'mutated', content: 'x' });
    assert.equal(group.getLedger().length, 1, 'getLedger() must return a shallow copy');

    group.reset();
    const concludeRes = /** @type {any} */ (await group.conclude({ instruction: 'debate' }));
    assert.equal(concludeRes.accepted, true);
    assert.ok(clientCalls.length >= 3, 'discussion, judge, and aggregator all routed through agent[0].client');
    assert.equal(groupCalls.length, 0, 'none of them fell back to the group client');

    const artDir = await fs.mkdtemp(join(tmpdir(), 'merci-art-'));
    try {
        await fs.writeFile(
            join(artDir, '.artifacts.json'),
            JSON.stringify({ entries: [null, 42, { bad: true }, { name: 'report.txt', version: 2, bytes: 1, ts: '', path: '' }] }),
            'utf8'
        );
        const tool = createSaveArtifactTool({ dir: artDir });
        const savedPath = await tool.execute({ args: { name: 'report.txt', content: 'hello' } });
        assert.match(savedPath, /report\.v3\.txt$/);
    } finally {
        await fs.rm(artDir, { recursive: true, force: true });
    }
});

// ── 5. Wave 2 Oracle Edge-Case Regression Proofs ──────────────────────────

test('5a (Defect 1): isSafeHttpUrl blocks IPv4-compatible/SIIT/NAT64/6to4 IPv6 & CGNAT/Benchmarking/Class-E IPv4, and CurlEngine blocks redirect SSRF', async () => {
    const wave2Blocked = [
        'http://[::127.0.0.1]/',
        'http://[::7f00:1]/',
        'http://[::a9fe:a9fe]/',
        'http://[::ffff:0:127.0.0.1]/',
        'http://[::ffff:0:7f00:1]/',
        'http://[64:ff9b::7f00:1]/',
        'http://[2002:7f00:1::]/',
        'http://100.64.0.1/',
        'http://100.100.100.200/latest/meta-data/',
        'http://100.127.255.254/',
        'http://198.18.0.1/',
        'http://198.19.255.254/',
        'http://240.0.0.1/',
        'http://255.255.255.255/',
    ];
    for (const url of wave2Blocked) {
        assert.equal(isSafeHttpUrl({ url }), false, `expected ${url} to be blocked`);
        assert.equal(urlPermitted({ url }), false, `expected urlPermitted(${url}) to be false`);
    }
    assert.equal(isSafeHttpUrl({ url: 'https://100.63.255.254/' }), true);
    assert.equal(isSafeHttpUrl({ url: 'https://100.128.0.1/' }), true);
    assert.equal(isSafeHttpUrl({ url: 'https://198.17.0.1/' }), true);
    assert.equal(isSafeHttpUrl({ url: 'https://198.20.0.1/' }), true);

    const orig = global.fetch;
    global.fetch = /** @type {any} */ (async () => ({
        ok: true,
        status: 200,
        url: 'http://169.254.169.254/latest/meta-data/iam',
        headers: { get: (/** @type {string} */ k) => (k === 'content-type' ? 'text/plain' : null) },
        text: async () => 'SECRET_METADATA',
    }));
    try {
        const [out] = /** @type {any[]} */ (await curlFetch({ input: 'https://example.com/open-redirect', opts: { lookup: PUBLIC_LOOKUP } }));
        assert.equal(out.content, '');
        assert.match(out.error, /domain policy/);
    } finally {
        global.fetch = orig;
    }
});

test('5b (Defect 2): CurlEngine streams up to MAX_SCRAPE_BYTES cancelling the reader and checks content-length', async () => {
    const orig = global.fetch;
    let cancelled = false;
    let chunksPulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(65); // 1 MB of 'A'
    global.fetch = /** @type {any} */ (async () => ({
        ok: true,
        status: 200,
        url: 'https://example.com/huge',
        headers: { get: (/** @type {string} */ k) => (k === 'content-type' ? 'text/plain' : null) },
        body: {
            getReader() {
                return {
                    async read() {
                        chunksPulled++;
                        return { value: chunk, done: false };
                    },
                    async cancel() {
                        cancelled = true;
                    },
                    releaseLock() {},
                };
            },
        },
        text: async () => { throw new Error('res.text() must not be called when body.getReader is available'); },
    }));
    try {
        const [out] = /** @type {any[]} */ (await curlFetch({ input: 'https://example.com/huge', opts: { lookup: PUBLIC_LOOKUP } }));
        assert.equal(cancelled, true, 'stream reader must be cancelled once MAX_SCRAPE_BYTES is exceeded');
        assert.equal(chunksPulled, 6, 'reads 5 full 1MB chunks + 6th chunk triggers cap and cancel');
        assert.equal(out.truncated, true);
        assert.equal(out.content.length, 5 * 1024 * 1024);
    } finally {
        global.fetch = orig;
    }
});

test('5c (Defect 3): WorkflowExecutor tracks cumulative token budget across steps and throws BudgetExceededError', async () => {
    /** @type {any[]} */
    const stepBudgets = [];
    const client = {
        session: () => ({
            provider: 'openai',
            withSystemMessage() { return this; },
            withCircuitBreaker() { return this; },
            run: async (/** @type {any} */ { options }) => {
                if (options?.budget) stepBudgets.push(options.budget);
                return 'x'.repeat(120); // ~30 tokens
            },
        }),
    };
    const exec = new WorkflowExecutor({
        options: {
            client,
            defaultModel: 'm',
            budget: { maxTotalTokens: 50 },
        },
    });
    exec.setSteps({
        stepsList: [
            { id: 's1', userPromptTemplate: 'step 1 prompt', dependencies: [] },
            { id: 's2', userPromptTemplate: 'step 2 prompt', dependencies: ['s1'] },
            { id: 's3', userPromptTemplate: 'step 3 prompt', dependencies: ['s2'] },
        ],
    });
    await assert.rejects(
        () => exec.execute({ userGoal: 'cumulative budget', objectiveOptions: { adaptable: false } }),
        BudgetExceededError
    );
    assert.equal(stepBudgets[0]?.maxTotalTokens, 50);
    assert.ok(stepBudgets.length <= 2, 'workflow stops as soon as cumulative tokens exceed maxTotalTokens');
    if (stepBudgets[1]) {
        assert.ok(stepBudgets[1].maxTotalTokens < 50, 'remaining budget decreases after step 1');
    }
});

test('5d (Defect 4): Evaluator replan on completed stepA resets failed sibling stepB from the same batch instead of crashing', async () => {
    let bAttempts = 0;
    let aAttempts = 0;
    const client = {
        session: () => ({
            provider: 'openai',
            withSystemMessage() { return this; },
            withCircuitBreaker() { return this; },
            run: async (/** @type {any} */ { initialInput }) => {
                const text = Array.isArray(initialInput) ? String(initialInput[0]?.content ?? '') : String(initialInput ?? '');
                if (text.includes('DO_B')) {
                    bAttempts++;
                    if (bAttempts === 1) throw new Error('transient B failure');
                    return 'B_OK';
                }
                aAttempts++;
                return aAttempts === 1 ? 'A_BAD' : 'A_GOOD';
            },
        }),
    };
    const evaluator = {
        evaluate: async (/** @type {any} */ { node }) => {
            if (node.id === 'a' && node.output === 'A_BAD') {
                return { replanRequired: true, reason: 'A needs rewrite' };
            }
            return { replanRequired: false };
        },
    };
    const planner = {
        replan: async () => ({
            steps: [
                { id: 'a', userPromptTemplate: 'DO_A_V2', dependencies: [] },
                { id: 'b', userPromptTemplate: 'DO_B', dependencies: [] },
            ],
        }),
    };
    const exec = new WorkflowExecutor({
        options: { client, defaultModel: 'm', maxReplanCount: 2 },
    });
    exec.setSteps({
        stepsList: [
            { id: 'a', userPromptTemplate: 'DO_A_V1', dependencies: [] },
            { id: 'b', userPromptTemplate: 'DO_B', dependencies: [] },
        ],
    });
    const out = /** @type {any} */ (await exec.execute({ userGoal: 'parallel evaluator replan + sibling fail', planner, evaluator, objectiveOptions: { adaptable: false } }));
    assert.equal(out.a.output, 'A_GOOD');
    assert.equal(out.b.output, 'B_OK');
});

test('5e (Defect 5): LocalFileSessionStore sanitizeId avoids collision between team/alice and team_alice and rejects dot/blank ids', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'merci-sess-collision-'));
    try {
        const store = new LocalFileSessionStore({ dir });
        await assert.rejects(() => store.save({ threadId: '   ', data: {} }), ConfigurationError);
        await assert.rejects(() => store.save({ threadId: '.', data: {} }), ConfigurationError);
        await assert.rejects(() => store.save({ threadId: '..', data: {} }), ConfigurationError);
        await assert.rejects(() => store.load('.'), ConfigurationError);

        await store.save({ threadId: 'team/alice', data: { messages: [{ role: 'user', content: 'slash' }] } });
        await store.save({ threadId: 'team_alice', data: { messages: [{ role: 'user', content: 'underscore' }] } });

        const fromSlash = await store.load('team/alice');
        const fromUnderscore = await store.load('team_alice');
        assert.equal(fromSlash?.messages?.[0]?.content, 'slash');
        assert.equal(fromUnderscore?.messages?.[0]?.content, 'underscore');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('5f (Defect 6): StateMachine constructor and graph mutators do not mutate caller graph, nodes, or edges in place', () => {
    const callerEdge = { from: 'a', to: 'b', condition: 'ctx.get("ok") === true' };
    const callerNodes = [
        { id: 'a', execute: () => 'a' },
        { id: 'b', execute: () => 'b', terminal: true },
    ];
    const callerEdges = [callerEdge];
    const callerGraph = { entry: 'a', nodes: callerNodes, edges: callerEdges };

    const sm = new StateMachine({ graph: callerGraph });
    assert.equal(typeof callerEdge.condition, 'string', 'caller edge condition must remain a string');

    const addedEdge = { from: 'b', to: 'c', condition: 'true' };
    sm.addNode({ nodeDef: { id: 'c', execute: () => 'c', terminal: true } });
    sm.addEdge({ edgeDef: addedEdge });
    assert.equal(callerNodes.length, 2, 'caller nodes array must not be mutated by addNode');
    assert.equal(callerEdges.length, 1, 'caller edges array must not be mutated by addEdge');
    assert.equal(typeof addedEdge.condition, 'string', 'caller edgeDef passed to addEdge must not be mutated in place');
});

