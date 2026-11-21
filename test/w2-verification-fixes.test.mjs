// @ts-check

/**
 * Wave 2 — the defects the independent verification wave found, each pinned.
 *
 * Every test in this file fails against the tree as it was before the
 * verification wave.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { BaseChatSession } from '../lib/agentic/chat-session.mjs';
import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { executeTools } from '../lib/tools/tool-execution.mjs';
import { capToolOutputValue } from '../lib/tools/external-capability.mjs';
import { createGuardrails, extractUserText } from '../lib/agentic/guardrails.mjs';
import { LocalFileSessionStore } from '../lib/agentic/sessions.mjs';
import { createOtlpExporter } from '../lib/support/otel-exporter.mjs';
import { createStreamingRetryPolicy } from '../lib/support/retry-policy.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { EVENTS, emitEvent } from '../lib/core/events.mjs';

// ── F5 — one owner retries the vendor call ───────────────────────────────────

/**
 * A session over a stub adapter whose vendor call always fails.
 * @param {{fail: () => void}} arg0
 * @returns {any}
 */
function failingSession({ fail }) {
    const adapter = {
        vendorName: 'STUB',
        buildVendorRequest: () => ({ request: {}, observability: { model: 'm' } }),
        executeVendorRequest: () => { fail(); const err = new Error('vendor down'); /** @type {any} */ (err).status = 503; throw err; },
        consumeStream: async function* () { /* never reached */ },
        extractXmlToolCalls: () => [],
        formatToolCall: (/** @type {any} */ { call }) => ({ id: call.id, name: call.name, args: {} })
    };
    return new (class extends BaseChatSession {})({
        vendorClient: {},
        model: 'm',
        eventEmitter: new EventEmitter(),
        provider: ProviderType.OPENAI,
        adapter,
        buildParameters: (/** @type {any} */ { s }) => s
    });
}

test('F5: a session that retries the vendor call does not retry it a second time', async () => {
    let calls = 0;
    const session = failingSession({ fail: () => { calls += 1; } });
    session._retryPolicy = createStreamingRetryPolicy({ overrides: { initialDelayMs: 1, jitterMs: 0 } });
    await assert.rejects(async () => {
        const gen = session.step({ messages: [] });
        let r = await gen.next();
        while (!r.done) r = await gen.next();
    }, /vendor down/);
    assert.equal(calls, 3, 'the session retries once (3 attempts), not twice (9)');
});

test('F5: a session without a retry policy calls the vendor exactly once', async () => {
    let calls = 0;
    const session = failingSession({ fail: () => { calls += 1; } });
    session._retryPolicy = null;
    await assert.rejects(async () => {
        const gen = session.step({ messages: [] });
        let r = await gen.next();
        while (!r.done) r = await gen.next();
    }, /vendor down/);
    assert.equal(calls, 1, 'without a policy there is no retry at all');
});

// ── F6 — the streamed conversation keeps the agent's own turns ───────────────

test('F6: a streamed input keeps the assistant turns in the conversation', async () => {
    const builder = new ChatSessionBuilder();
    /** @type {Array<Array<any>>} */
    const turns = [];
    builder._runOnce = async ({ initialInput }) => {
        turns.push([...initialInput]);
        // The session's own message list after the turn (what the model saw).
        builder._lastStepMessages = [...(/** @type {Array<Object>} */ (initialInput)), { role: 'assistant', content: 'answer' }];
        return 'answer';
    };
    async function* input() {
        yield 'first';
        yield 'second';
    }
    await builder.run({ initialInput: /** @type {any} */ (input()) });
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0].map((m) => m.role), ['user']);
    assert.deepEqual(turns[1].map((m) => m.role), ['user', 'assistant', 'user'], 'the second turn carries the first answer');
});

// ── F7 — the guardrail watches every user turn ───────────────────────────────

test('F7: the input guardrail sees every user turn, not only the last', async () => {
    const text = extractUserText({ messages: [
        { role: 'user', content: 'my key is AKIA1234' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'and now something else' }
    ] });
    assert.match(text, /AKIA1234/, 'the first turn is part of what the model receives');

    const guardrails = createGuardrails({ rules: [{ name: 'no-keys', phase: 'input', pattern: /AKIA\d+/ }] });
    const verdict = await guardrails.check({ phase: 'input', text });
    assert.equal(verdict.blocked, true, 'a secret in an earlier turn still trips the rule');
});

test('F7: an earlier secret blocks the run before the model is called', async () => {
    const guardrails = createGuardrails({ rules: [{ name: 'no-keys', phase: 'input', pattern: /AKIA\d+/ }] });
    let called = false;
    const session = {
        provider: ProviderType.OPENAI,
        model: 'gpt-4o',
        _tools: [],
        _guardrails: guardrails,
        eventEmitter: new EventEmitter(),
        async *step() { called = true; }
    };
    await assert.rejects(
        () => runAgenticLoop({ session, messages: [
            { role: 'user', content: 'my key is AKIA1234' },
            { role: 'assistant', content: 'ok' },
            { role: 'user', content: 'and now something else' }
        ] }),
        /no-keys/
    );
    assert.equal(called, false, 'the model was never called');
});

// ── F9 — the output cap bounds the keys too ─────────────────────────────────

test('F9: the output cap bounds the key length as well as the values', () => {
    /** @type {Record<string, any>} */
    const value = {};
    for (let i = 0; i < 10; i++) value['k'.repeat(200_000) + i] = 'v';
    const capped = capToolOutputValue({ value, maxLength: 50_000 });
    assert.equal(capped.truncated, true);
    const size = JSON.stringify(capped.value).length;
    assert.equal(size <= 60_000, true, `the capped payload is bounded (was ${size})`);
});

// ── F11 — the price is checked BEFORE the model is billed ────────────────────

test('F11: a USD budget the backend cannot report does not refuse the run', async () => {
    // Wave 3 removed the price table: the SDK never estimates a price, so a
    // money budget the backend cannot report is announced, not fatal — the
    // token budget is the mechanism.
    let calls = 0;
    const session = {
        provider: ProviderType.OPENAI,
        model: 'mystery-model',
        _tools: [],
        _budget: { maxBudgetUsd: 1 },
        eventEmitter: new EventEmitter(),
        /**
         * @param {{messages: any[]}} arg0
         */
        async *step({ messages }) {
            calls += 1;
            yield { type: 'quota', data: { prompt_tokens: 10, completion_tokens: 5 } };
            return { done: true, content: 'hi', messages: [...messages, { role: 'assistant', content: 'hi' }] };
        }
    };
    /** @type {any[]} */
    const notices = [];
    session.eventEmitter.on(EVENTS.CLIENT.BUDGET_UNREPORTED, (/** @type {any} */ e) => notices.push(e));
    const out = await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] });
    assert.equal(out, 'hi', 'the run is not refused');
    assert.equal(calls, 1, 'the model is called — the token budget governs');
    assert.equal(notices.length, 1, 'the unenforceable money budget is announced');
});

// ── F10 — the dangerous permission mode says so ─────────────────────────────

test('F10: bypassPermissions announces that it approves everything', () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const seen = [];
    emitter.on(EVENTS.PERMISSIONS.BYPASS, (/** @type {any} */ e) => seen.push(e));
    const builder = new ChatSessionBuilder();
    builder.eventEmitter = emitter;
    builder.withPermissions({ mode: 'bypassPermissions' });
    assert.equal(seen.length, 1, 'the dangerous mode is announced');
    const announced = seen[0];
    assert.equal((announced.payload ?? announced).mode, 'bypassPermissions');
});

// ── F13/F14 — the public entry points exist and work ─────────────────────────

test('F14: the new helpers are on the public barrel', async () => {
    const sdk = await import('../lib/index.mjs');
    assert.equal(typeof sdk.capToolOutputValue, 'function');
    assert.equal(typeof sdk.createOtlpExporter, 'function');
    const tools = await import('../lib/tools/index.mjs');
    assert.equal(typeof tools.withToolTimeout, 'function');
});

test('F14: withTelemetry attaches the exporter to the session emitter', async () => {
    /** @type {any[]} */
    const posted = [];
    const exporter = createOtlpExporter({
        endpoint: 'http://127.0.0.1:4318/v1/traces',
        fetchImpl: async (/** @type {any} */ url, /** @type {any} */ init) => {
            posted.push(JSON.parse(String(init.body)));
            return { ok: true, status: 200 };
        }
    });
    const builder = new ChatSessionBuilder();
    builder.eventEmitter = new EventEmitter();
    builder.withTelemetry({ exporter });
    emitEvent({ emitter: builder.eventEmitter, name: EVENTS.CLIENT.RUN_START, payload: { runId: 'r1' } });
    await exporter.flush();
    assert.equal(posted.length, 1, 'the exporter posted the event');
    assert.equal(posted[0].resourceSpans[0].scopeSpans[0].spans[0].name, EVENTS.CLIENT.RUN_START);
    await exporter.close();
});

test('F14: forkCheckpoint branches the stored thread', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-w2-fork-'));
    try {
        const store = new LocalFileSessionStore({ dir });
        await store.save({ threadId: 'src', data: { messages: [{ role: 'user', content: 'hi' }], agentContext: { objective: 'o' } } });
        const builder = new ChatSessionBuilder();
        builder._sessionStore = store;
        builder._threadId = 'src';
        const forked = await builder.forkCheckpoint({ newThreadId: 'branch' });
        assert.ok(forked, 'the fork returns the checkpoint');
        const loaded = await store.load('branch');
        assert.equal(loaded?.messages?.length, 1);
        const source = await store.load('src');
        assert.equal(source?.messages?.length, 1, 'the source is untouched');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// ── F8 — the legacy frontmatter reader is the fallback ──────────────────────

test('F8: a frontmatter the legacy reader understands still loads', async () => {
    const { loadSkillsFromDirectory } = await import('../lib/tools/skills.mjs');
    const dir = await mkdtemp(join(tmpdir(), 'merci-w2-legacy-'));
    try {
        const { mkdir, writeFile } = await import('node:fs/promises');
        await mkdir(join(dir, 's'), { recursive: true });
        await writeFile(join(dir, 's', 'SKILL.md'), ['---', 'name: s', 'description: Use this: for that', '---', 'Body.', ''].join('\n'));
        const tools = await loadSkillsFromDirectory({ directory: dir });
        assert.equal(tools.length, 1, 'the skill loads');
        assert.equal(tools[0].description, 'Use this: for that');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// ── F1/F2/F3/F4 — the vendor request keys land on the right endpoint ────────

test('F1: previous_response_id never reaches the chat completions request', async () => {
    const { oaiAdapter } = await import('../lib/backends/adapters/oai-adapter.mjs');
    const { UnifiedParameterBuilder } = await import('../lib/messaging/unified-parameter.mjs');
    const builder = new UnifiedParameterBuilder({ model: 'm', provider: ProviderType.OPENAI });
    builder.previousResponseId({ v: 'resp_1' });
    const built = /** @type {any} */ (oaiAdapter).buildVendorRequest({
        model: 'm',
        parameters: builder._build(),
        tools: [],
        preparedMessages: [{ role: 'user', content: 'hi' }],
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: { protocol: 'completions', provider: ProviderType.OPENAI }
    });
    assert.equal(built.request.previous_response_id, undefined, 'the completions endpoint rejects an unknown parameter');
});

test('F2: service_tier reaches the Anthropic request', async () => {
    const { aaiAdapter } = await import('../lib/backends/adapters/aai-adapter.mjs');
    const { UnifiedParameterBuilder, buildParameterMapForAai } = await import('../lib/messaging/unified-parameter.mjs');
    const builder = new UnifiedParameterBuilder({ model: 'm', provider: ProviderType.ANTHROPIC });
    builder.serviceTier({ v: 'priority' });
    const built = /** @type {any} */ (aaiAdapter).buildVendorRequest({
        model: 'm',
        parameters: buildParameterMapForAai({ spec: builder._build() }),
        tools: [],
        preparedMessages: [{ role: 'user', content: 'hi' }],
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: { provider: ProviderType.ANTHROPIC }
    });
    assert.equal(built.request.service_tier, 'priority');
});

test('F3: asking for the top-k log probabilities implies logprobs', async () => {
    const { UnifiedParameterBuilder, buildParameterMapForOai } = await import('../lib/messaging/unified-parameter.mjs');
    const builder = new UnifiedParameterBuilder({ model: 'm', provider: ProviderType.OPENAI });
    builder.logprobsTopK({ v: 3 });
    const map = buildParameterMapForOai({ spec: builder._build() });
    assert.equal(map.logprobs, true, 'OpenAI ignores top_logprobs without logprobs');
    assert.equal(map.top_logprobs, 3);
});

test('F4: the Responses endpoint asks for the log probabilities through include', async () => {
    const { oaiAdapter } = await import('../lib/backends/adapters/oai-adapter.mjs');
    const { UnifiedParameterBuilder } = await import('../lib/messaging/unified-parameter.mjs');
    const builder = new UnifiedParameterBuilder({ model: 'm', provider: ProviderType.OPENAI });
    builder.logprobs({ v: true });
    const built = /** @type {any} */ (oaiAdapter).buildVendorRequest({
        model: 'm',
        parameters: builder._build(),
        tools: [],
        preparedMessages: [{ role: 'user', content: 'hi' }],
        forceTextResponse: false,
        toolChoiceRequired: false,
        session: { protocol: 'responses', provider: ProviderType.OPENAI }
    });
    assert.equal(built.request.logprobs, undefined, 'the Responses API has no boolean logprobs field');
    assert.ok((built.request.include ?? []).includes('message.output_text.logprobs'));
});

// ── the object cap keeps the shape ───────────────────────────────────────────

test('the object cap keeps the top-level shape and elides what does not fit', async () => {
    const results = /** @type {any[]} */ (await executeTools({
        toolCalls: [{ id: 'c1', name: 'fat', arguments: '{}' }],
        toolLibrary: [{
            name: 'fat',
            description: 'a huge object',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ blob: 'x'.repeat(200_000), nested: { also: 'y'.repeat(200_000) } })
        }]
    }));
    assert.equal(typeof results[0].result, 'object');
    assert.equal(results[0].result.nested, '[…]');
});
