// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { LocalFileMemoryProvider, CompositeMemoryProvider } from '../lib/agentic/memory/providers.mjs';
import { ProviderMemoryEngine } from '../lib/agentic/memory/engine.mjs';
import { MemoryManager } from '../lib/agentic/memory/manager.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { WorkflowEvaluator } from '../lib/agentic/planning/evaluator.mjs';
import { ExponentialBackoffPolicy, runWithRetry, sleepAbortable } from '../lib/support/retry-policy.mjs';
import { wrapError, AbortedError, ConfigurationError, BackendError, MerciError } from '../lib/core/errors.mjs';
import { loadMcpTools } from '../lib/tools/mcp-client.mjs';
import { oaiAdapter } from '../lib/backends/adapters/oai-adapter.mjs';
import { ProviderType, EnvKey } from '../lib/core/constants/index.mjs';
import { MerciClient as OAIClient } from '../lib/backends/oai.mjs';

import { getEventListeners } from 'node:events';

// ─── 16: rolling summary fold ────────────────────────────────────────────────

/**
 * @param {{onRun: (history: any) => any}} arg0
 */
function makeCaptureSession({ onRun }) {
    const stubSession = {
        withSystemMessage() { return this; },
        withTools() { return this; },
        withTodos() { return this; },
        withRetryPolicy() { return this; },
        withStreamTimeout() { return this; },
        /** @param {{initialInput: *}} arg0 */
        async run({ initialInput: history }) { return onRun(history); },
    };
    const session = new DiscussionSession({ client: { session: () => stubSession }, options: {} });
    session.addAgent({ name: 'alpha', model: 'm', provider: ProviderType.OPENAI });
    return session;
}

test('16 summary folds only the delta: later turns do not re-send the whole prefix', async () => {
    /** @type {any[]} */
    const calls = [];
    const summarize = async (/** @type {any} */ text) => { calls.push(text); return `S${calls.length}`; };
    const session = makeCaptureSession({ onRun: () => 'ok' });
    session.appendLedger({ entries: [{ author: 'a0', content: 'entry0', type: 'discussion', thoughtSignature: null }] });
    session.appendLedger({ entries: [{ author: 'a1', content: 'entry1', type: 'discussion', thoughtSignature: null }] });
    session.appendLedger({ entries: [{ author: 'a2', content: 'entry2', type: 'discussion', thoughtSignature: null }] });
    await session.discuss({ instruction: 't1', tail: 1, summarize });
    await session.discuss({ instruction: 't2', tail: 1, summarize });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes('entry0') && calls[0].includes('entry1'), 'first fold covers entries [0,1]');
    assert.ok(calls[1].includes('S1'), 'second fold reuses the previous summary');
    assert.ok(calls[1].includes('entry2'), 'second fold covers only the new entry');
    assert.ok(!calls[1].includes('entry1'), 'no re-send of already-summarized entries');
});

test('16b a DIFFERENT summarize callback never reuses another phase\'s summary', async () => {
    /** @type {any[]} */
    const calls = [];
    const session = makeCaptureSession({ onRun: () => 'ok' });
    session.appendLedger({ entries: [{ author: 'a0', content: 'entry0', type: 'discussion', thoughtSignature: null }] });
    session.appendLedger({ entries: [{ author: 'a1', content: 'entry1', type: 'discussion', thoughtSignature: null }] });
    await session.discuss({ instruction: 't1', tail: 1, summarize: /** @type {(...args: any[]) => any} */ (async (text) => { calls.push(['A', text]); return 'SA'; }) });
    await session.discuss({ instruction: 't2', tail: 1, summarize: async (/** @type {any} */ text) => { calls.push(['B', text]); return 'SB'; } });
    assert.equal(calls.length, 2);
    assert.ok(calls[1][0] === 'B');
    assert.ok(!calls[1][1].includes('SA'), 'a different callback starts from scratch, not from A\'s fold');
});

// ─── 17: embedder scoping ────────────────────────────────────────────────────

test('17 per-session embedders do not mutate the shared provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-emb-'));
    try {
        const provider = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'mem.json') } });
        await provider.store({ content: 'fact one', category: undefined, targetBanks: [], embedder: async () => [0.5] });
        let callsA = 0, callsB = 0;
        const engineA = new ProviderMemoryEngine({ provider, embedder: async () => { callsA++; return [0.1]; } });
        const engineB = new ProviderMemoryEngine({ provider, embedder: async () => { callsB++; return [0.2]; } });
        assert.equal(provider.embedder, null, 'the provider field must stay untouched');
        const blockA = await engineA.load({ query: 'fact one' });
        const blockB = await engineB.load({ query: 'fact one' });
        assert.ok(blockA && blockB, 'both sessions get a vector-tier result');
        assert.equal(callsA, 1);
        assert.equal(callsB, 1);
        assert.equal(provider.embedder, null, 'still no mutation after queries');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('17 the manager threads its own embedder per-call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-emb2-'));
    try {
        const provider = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'mem.json') } });
        await provider.store({ content: 'fact one', category: undefined, targetBanks: [], embedder: async () => [0.5] });
        let calls = 0;
        const manager = new MemoryManager({ provider, options: { embedder: async () => { calls++; return [0.3]; } } });
        await manager.buildMemoryBlock({ messages: [{ role: 'user', content: 'fact one' }] });
        assert.equal(calls, 1, 'the manager query uses the manager-scoped embedder');
        assert.equal(provider.embedder, null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// ─── 19: step() abort-listener disposal ──────────────────────────────────────

function makeBrokenSession() {
    const session = new AbstractChatSession({ provider: 'openai', model: 'm', eventEmitter: new EventEmitter(), client: {} });
    return session;
}

test('19 a buildVendorRequest throw disposes the step abort listener', async () => {
    const ac = new AbortController();
    const session = makeBrokenSession();
    session._adapter = /** @type {any} */ ({ vendorName: 'FAKE', buildVendorRequest() { throw new Error('boom'); } });
    await assert.rejects(async () => {
        for await (const _ of session.step({ messages: [], options: { signal: ac.signal } })) { /* noop */ }
    }, /boom/);
    assert.equal((/** @type {any} */ (getEventListeners))(ac.signal).length, 0, 'no listener may linger after the throw');
});

test('19 a consumer break disposes the step abort listener', async () => {
    const ac = new AbortController();
    const session = makeBrokenSession();
    session._adapter = {
        vendorName: 'FAKE',
        buildVendorRequest: () => ({ request: {}, observability: {} }),
        executeVendorRequest: async () => ({}),
        consumeStream: async function* () { yield { type: 'text', content: 'hi' }; },
        extractXmlToolCalls: () => [],
        /** @param {{call: *}} arg0 */
        formatToolCall: ({ call }) => ({ id: call.id, name: '', args: '{}' }),
    };
    for await (const _ of session.step({ messages: [], options: { signal: ac.signal } })) {
        break;
    }
    assert.equal((/** @type {any} */ (getEventListeners))(ac.signal).length, 0, 'a break must not leak the listener');
});

// ─── 20: replan that re-ids a failed step ────────────────────────────────────

test('20 a replan replacing a failed step with a new id does not hard-halt', async () => {
    const client = { session: () => ({
        provider: 'openai',
        withSystemMessage() { return this; },
        withTools() { return this; },
        withMemory() { return this; },
        withTodos() { return this; },
        withParameters() { return this; },
        run: async () => 'answer',
    }) };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: '', userPromptTemplate: 'x', dependencies: [] }] });
    let replans = 0;
    let evalCalls = 0;
    const outputs = /** @type {any} */ (await executor.execute({ userGoal: 'goal', planner: {
        replan: async () => {
            replans++;
            if (replans === 1) {
                (/** @type {any} */ (executor.steps)).get('a').status = 'failed';
                (/** @type {any} */ (executor.steps)).get('a').output = 'Error: boom';
                return { steps: [{ id: 'b', title: 'B', systemPrompt: '', userPromptTemplate: 'y', dependencies: [] }] };
            }
            return { steps: [{ id: 'b', title: 'B', systemPrompt: '', userPromptTemplate: 'y', dependencies: [] }] };
        },
    }, evaluator: {
        evaluate: async () => ({ replanRequired: ++evalCalls === 1, reason: 'needs replan' }),
    } }));
    assert.equal(outputs.b.output, 'answer', 'the replacement step must run to completion');
    assert.ok(replans >= 1);
});

// ─── 21: evaluator rethrows ──────────────────────────────────────────────────

test('21 the built-in evaluator propagates outages instead of returning verified-OK', async () => {
    const evaluator = new WorkflowEvaluator({ options: {
        client: { session: () => ({
            withSystemMessage() { return this; },
            withTools() { return this; },
            withParameters() { return this; },
            run: async () => { throw new Error('provider down'); },
        }) },
        model: 'm',
    } });
    await assert.rejects(() => evaluator.evaluate({ node: { id: 's1', output: 'x' }, outputs: {} }), /provider down/);
});

// ─── 22: memory save() surfaces failures ─────────────────────────────────────

test('22 a write failure makes store() reject instead of silently losing the fact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-save-'));
    try {
        const provider = new LocalFileMemoryProvider({ options: { filePath: dir } });
        await assert.rejects(() => provider.store({ content: 'fact' }), (/** @type {any} */ e) => e.code === 'EISDIR' || e.code === 'EACCES' || e.code === 'EPERM');
        assert.equal(provider.facts.length, 0, 'an unwritten fact must not be reported as stored');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// ─── 24: backfill is attempted once per fact ─────────────────────────────────

test('24 a down embedder is not re-hammered on every vector query', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-bf-'));
    try {
        const provider = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'mem.json') } });
        provider.facts = [{ id: 'legacy1', content: 'legacy fact', timestamp: 1 }];
        provider._loaded = true;
        const calls = [];
        provider.embedder = async () => { calls.push(1); throw new Error('embedder down'); };
        await provider.query({ text: 'anything', limit: 5 });
        const afterFirstQuery = calls.length;
        assert.equal(afterFirstQuery, 2, 'first query: backfill + query embed');
        await provider.query({ text: 'anything', limit: 5 });
        assert.equal(calls.length - afterFirstQuery, 1, 'second query must NOT re-backfill the failed fact');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// ─── 26: retry policy error shapes ───────────────────────────────────────────

test('26 retry policy sees statusCode and cause-chain syscall codes', () => {
    const p = new ExponentialBackoffPolicy({ maxRetries: 2 });
    assert.equal(p.shouldRetry({ error: /** @type {any} */ ({ statusCode: 429 }), attempt: 0 }).retry, true, 'statusCode (not status) is transient');
    assert.equal(p.shouldRetry({ error: /** @type {any} */ ({ statusCode: 503 }), attempt: 0 }).retry, true);
    const fetchFailed = new Error('fetch failed');
    fetchFailed.cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    assert.equal(p.shouldRetry({ error: fetchFailed, attempt: 0 }).retry, true, 'a wrapped ECONNRESET is transient');
    assert.equal(p.shouldRetry({ error: new TypeError('programming bug'), attempt: 0 }).retry, false);
});

// ─── 27: runWithRetry is abort-aware ─────────────────────────────────────────

test('27 an abort during backoff rejects fast instead of waiting out the delay', async () => {
    // Two sources of nondeterminism had to go:
    //  - the abort timer (`setTimeout(30)`) could land before or during the sleep;
    //  - the policy jitters by default, so even a signal-ignoring sleep waits a
    //    U(0, 5000) draw and the `< 2000` bound passed ~40% of the time.
    // Abort from `onRetry` (the moment before the sleep) with `jitterMs: 0` (an
    // exact 5000 ms delay): a sleep that ignores the signal now always takes 5 s.
    const ac = new AbortController();
    const op = async () => { throw Object.assign(new Error('down'), { status: 500 }); };
    const start = Date.now();
    const pending = runWithRetry({
        operation: op,
        policy: new ExponentialBackoffPolicy({ maxRetries: 5, initialDelayMs: 5000, maxDelayMs: 5000, jitterMs: 0 }),
        signal: ac.signal,
        onRetry: () => ac.abort(new Error('cancel')),
    });
    await assert.rejects(pending, (e) => e instanceof AbortedError);
    assert.ok(Date.now() - start < 2000, 'must not wait 5s of backoff');
});

test('27b sleepAbortable rejects on an abort that arrives mid-sleep', async () => {
    // The unit behind the integration test above: no loop, no race — the sleep is
    // already running when the abort lands, which is the case the integration test
    // cannot pin deterministically.
    const ac = new AbortController();
    const start = Date.now();
    const sleeping = sleepAbortable({ ms: 5000, signal: ac.signal });
    setTimeout(() => ac.abort(new Error('cancel')), 20);
    await assert.rejects(sleeping, (e) => e instanceof AbortedError);
    assert.ok(Date.now() - start < 1000, 'the sleep must be interrupted, not waited out');
});

test('27 runWithRetry stops at the policy cap', async () => {
    let attempts = 0;
    const op = async () => { attempts++; throw Object.assign(new Error('down'), { status: 500 }); };
    await assert.rejects(() => runWithRetry({ operation: op, policy: new ExponentialBackoffPolicy({ maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1 }) }));
    assert.equal(attempts, 3, 'first try + 2 retries');
});

// ─── 29: typed config errors + wrapError classification ─────────────────────

test('29 backend constructors throw ConfigurationError', () => {
    const saved = {
        [EnvKey.ANTHROPIC_API_KEY]: process.env[EnvKey.ANTHROPIC_API_KEY],
        [EnvKey.GEMINI_API_KEY]: process.env[EnvKey.GEMINI_API_KEY],
        [EnvKey.OPENROUTER_API_KEY]: process.env[EnvKey.OPENROUTER_API_KEY],
        [EnvKey.OPENAI_API_KEY]: process.env[EnvKey.OPENAI_API_KEY],
    };
    delete process.env[EnvKey.ANTHROPIC_API_KEY];
    delete process.env[EnvKey.GEMINI_API_KEY];
    delete process.env[EnvKey.OPENROUTER_API_KEY];
    delete process.env[EnvKey.OPENAI_API_KEY];
    try {
        assert.throws(() => new OAIClient({}), ConfigurationError);
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
    assert.throws(() => new MemoryManager({ provider: /** @type {any} */ ({}) }), ConfigurationError);
});

test('29 wrapError no longer turns programming bugs into BackendError', () => {
    const wrapped = wrapError({ err: new TypeError('cannot read properties of undefined'), hints: { provider: 'openai' } });
    assert.ok(wrapped instanceof MerciError, 'a code bug stays a MerciError');
    assert.ok(!(wrapped instanceof BackendError));
    const vendor = wrapError({ err: Object.assign(new Error('rate limited'), { status: 429 }), hints: { provider: 'openai' } });
    assert.ok(vendor instanceof BackendError, 'a real vendor shape still classifies');
    assert.equal(vendor.status, 429);
});

// ─── 30: MCP teardown on load failure ────────────────────────────────────────

test('30 loadMcpTools stops the transport when getTools fails', async () => {
    let stopped = 0;
    const client = {
        start: async () => {},
        getTools: async () => { throw new Error('list failed'); },
        stop: async () => { stopped++; },
    };
    await assert.rejects(() => loadMcpTools({ mcpClient: /** @type {any} */ (client) }), /list failed/);
    assert.equal(stopped, 1, 'the transport child must be torn down');
});

// ─── 32: the OAI wire boundary honours stream:false ─────────────────────────
// Wave 2 made the non-streaming call a supported path (it used to be
// rejected), so the boundary now has to carry the flag instead of refusing it.

test('32 buildVendorRequest carries stream:false to the wire and defaults to streaming', () => {
    const session = { protocol: 'completions', provider: ProviderType.OPENAI };
    const nonStreaming = /** @type {any} */ ((/** @type {any} */ (oaiAdapter)).buildVendorRequest({
        model: 'm', parameters: { stream: false }, tools: [], preparedMessages: [],
        forceTextResponse: false, toolChoiceRequired: false, session,
    }));
    assert.equal(nonStreaming.request.stream, false, 'the caller asked for no streaming');
    const ok = /** @type {any} */ ((/** @type {any} */ (oaiAdapter)).buildVendorRequest({
        model: 'm', parameters: {}, tools: [], preparedMessages: [],
        forceTextResponse: false, toolChoiceRequired: false, session,
    }));
    assert.equal(ok.request.stream, true, 'streaming stays the default');
});
