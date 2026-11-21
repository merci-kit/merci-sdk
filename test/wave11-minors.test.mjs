// @ts-check

/**
 * Wave 11 — the three minors left after wave 10.
 *
 * F7  — a normalizer strips `merciId`, so "normalize, then dedupe" silently lost the
 *       replay protection. A replay must not cross the wire boundary whichever order
 *       the caller uses.
 * N4  — a background result was dropped when the parent's last message was a tool
 *       round; the round is now split (a synthetic result for every unanswered call)
 *       instead of losing the notification.
 * N5  — a continued spawn runs a turn with no event forwarder, so the continuation
 *       is invisible even though its first turn streams.
 *
 * Check-first: written before the fixes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
    createUserMessage, createAssistantMessage, createToolCallMessage,
    normalizeToOAI, normalizeToAAI, normalizeToGAI, normalizeHistory, dedupeMessages,
} from '../lib/messaging/messages.mjs';
import { formatJaiMessages } from '../lib/backends/jai-vendor/messages.mjs';
import { interleavePendingRows } from '../lib/agentic/pending-inbox.mjs';
import { withTaskAgents, createTaskTool } from '../lib/agentic/task.mjs';
import { listSpawns } from '../lib/agentic/spawn-registry.mjs';
import { RunContext } from '../lib/core/events.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

// ─── F7: identity leaves at normalization, so the dedupe must happen there ───

test('F7/wire-dedupe: a replayed row never reaches any wire, whatever the call order', () => {
    const alpha = createUserMessage({ provider: ProviderType.OPENAI, content: 'ALPHA' });
    const beta = createAssistantMessage({ provider: ProviderType.OPENAI, content: 'BETA' });
    // The same identity with different content: a replay, not a second question.
    const replay = { ...alpha, content: 'ALPHA-REPLAY' };
    const history = [alpha, beta, replay];

    /** @type {Array<[string, any]>} */
    const wires = [
        ['OAI', normalizeToOAI({ model: 'test-model', msgs: history })],
        ['AAI', normalizeToAAI({ msgs: history })],
        ['GAI', normalizeToGAI({ msgs: history })],
        ['JAI', formatJaiMessages({ messages: history })],
        ['normalizeHistory(JAI)', normalizeHistory({ provider: ProviderType.JAI, messages: history })],
    ];
    for (const [name, wire] of wires) {
        const text = JSON.stringify(wire);
        assert.ok(!text.includes('ALPHA-REPLAY'), `${name}: the replay is not on the wire`);
        assert.equal(text.split('"ALPHA"').length - 1, 1, `${name}: the original is sent once`);
    }
    // The wire stays identity-free: the dedupe is a boundary guarantee, not a leak.
    for (const [name, wire] of wires) {
        assert.ok(!JSON.stringify(wire).includes('merciId'), `${name}: no identity on the wire`);
    }
    // And the identity layer still works on the rows themselves.
    assert.equal(dedupeMessages({ messages: history }).length, 2, 'dedupe on raw rows is unchanged');
});

// ─── N4: a background result splits a dangling tool round ───

/** @returns {any} */
function makeClient() {
    /** @type {any[]} */
    const sessions = [];
    const client = {
        provider: ProviderType.OPENAI,
        sessions,
        emit: () => false,
        /** @param {string} model */
        session(model) {
            /** @type {any} */
            const s = {
                model,
                provider: ProviderType.OPENAI,
                client,
                _lastStepMessages: [],
                _lastRunUsage: null,
                withSystemMessage() { return s; },
                withTools() { return s; },
                withRetryPolicy() { return s; },
                withHeaderTimeout() { return s; },
                withMaxElapsedMs() { return s; },
                withApproval() { return s; },
                withBudget() { return s; },
                withCircuitBreaker() { return s; },
                withPermissions() { return s; },
                withToolAllowlist() { return s; },
                /** @param {{initialInput?: any[], options?: any}} [arg0] */
                async run({ initialInput = [], options } = {}) {
                    options?.onEvent?.({ type: 'text', content: 'child work' });
                    s._lastStepMessages = [...(s._lastStepMessages ?? []), ...initialInput,
                        createAssistantMessage({ provider: ProviderType.OPENAI, content: 'child answer' })];
                    Object.defineProperty(s, '_lastRunUsage', { value: { promptTokens: 10 }, configurable: true });
                    return 'child answer';
                },
            };
            sessions.push(s);
            return s;
        },
    };
    return client;
}

/** @param {any} client @returns {any} */
function parentSession(client) {
    /** @type {any} */
    const parent = {
        client,
        model: 'parent-model',
        provider: ProviderType.OPENAI,
        eventEmitter: new EventEmitter(),
        _taskDepth: 0,
        _lastStepMessages: [createUserMessage({ provider: ProviderType.OPENAI, content: 'root question' })],
        /** @param {{initialInput?: any[]}} [arg0] */
        async run({ initialInput = [] } = {}) {
            parent.lastInitialInput = initialInput;
            return { result: 'parent answer', messages: initialInput, deltaMessages: [], signature: null, provider: ProviderType.OPENAI, usage: null };
        },
    };
    return parent;
}

test('N4/inbox-tool-tail: a background result is not dropped when the parent ends on a tool call', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    const parent = parentSession(client);
    parent._lastStepMessages = [
        createUserMessage({ provider: ProviderType.OPENAI, content: 'root question' }),
        createToolCallMessage({ provider: ProviderType.OPENAI, id: 'call_1', name: 'read_file', args: { path: 'a.txt' } }),
    ];
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({
        args: { prompt: 'Do X', subagent_type: 'explore', background: true },
    });
    const [spawn] = listSpawns({ client });
    await spawn.wait();
    await new Promise((r) => setTimeout(r, 10));
    const inbox = parent._pendingInputRows ?? [];
    assert.equal(inbox.length, 1, 'the result waits in the inbox instead of vanishing');
    assert.ok(String(inbox[0].content).includes('child answer'), 'it carries the child result');
});

test('N4/split-oai: a dangling tool round is closed before the notification lands', () => {
    const rows = [
        createUserMessage({ provider: ProviderType.OPENAI, content: 'question' }),
        createToolCallMessage({ provider: ProviderType.OPENAI, id: 'call_1', name: 'read_file', args: { path: 'a.txt' } }),
        createUserMessage({ provider: ProviderType.OPENAI, content: 'next question' }),
    ];
    const notification = createAssistantMessage({ provider: ProviderType.OPENAI, content: '[Subagent "explore" finished]\ndone' });
    const out = interleavePendingRows({ rows, pending: [notification] });
    const kinds = out.map((/** @type {any} */ m) => (m.role === 'tool' ? 'result' : (String(m.content).includes('Subagent') ? 'notice' : (m.tool_calls ? 'call' : 'text'))));
    assert.deepEqual(kinds, ['text', 'call', 'result', 'notice', 'text'], 'the round is closed, then the notification, then the prompt');
    const result = out[2];
    assert.equal(result.tool_call_id, 'call_1', 'the synthetic result answers the call by id');
    assert.match(String(result.content), /did not run/i, 'and says so plainly');
});

test('N4/split-gai: the Gemini shape is closed with a functionResponse of the same name', () => {
    const rows = [
        createUserMessage({ provider: ProviderType.GOOGLE_GENAI, content: 'question' }),
        createToolCallMessage({ provider: ProviderType.GOOGLE_GENAI, id: 'g1', name: 'read_file', args: { path: 'a.txt' } }),
        createUserMessage({ provider: ProviderType.GOOGLE_GENAI, content: 'next question' }),
    ];
    const notification = createAssistantMessage({ provider: ProviderType.GOOGLE_GENAI, content: '[Subagent "explore" finished]\ndone' });
    const out = interleavePendingRows({ rows, pending: [notification] });
    const closed = out.find((/** @type {any} */ m) => Array.isArray(m.parts) && m.parts.some((/** @type {any} */ p) => p?.functionResponse));
    assert.ok(closed, 'a functionResponse row was inserted');
    assert.equal(/** @type {any} */ (closed.parts)[0].functionResponse.name, 'read_file', 'matched to the call by name');
    assert.equal(out.indexOf(closed), 2, 'and it sits right after the call');
});

test('N4/split-partial: a half-answered multi-call row gets only the missing result', () => {
    const rows = [
        createUserMessage({ provider: ProviderType.OPENAI, content: 'question' }),
        /** @type {any} */ ({
            role: 'assistant', content: 'calling',
            tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                { id: 'call_2', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
            ],
        }),
        /** @type {any} */ ({ role: 'tool', tool_call_id: 'call_1', content: 'file body' }),
        createUserMessage({ provider: ProviderType.OPENAI, content: 'next question' }),
    ];
    const notification = createAssistantMessage({ provider: ProviderType.OPENAI, content: '[Subagent "explore" finished]\ndone' });
    const out = interleavePendingRows({ rows, pending: [notification] });
    const results = out.filter((/** @type {any} */ m) => m.role === 'tool');
    assert.equal(results.length, 2, 'exactly one synthetic result for the unanswered call');
    assert.equal(results[1].tool_call_id, 'call_2', 'and it is the missing one');
    assert.equal(out.indexOf(results[1]), 3, 'placed right after the first result');
    assert.equal(String(out[4]?.content ?? '').includes('Subagent'), true, 'then the notification');
});

test('N4/no-split: a normal history is untouched, and an answered round is not closed twice', () => {
    const answered = [
        createUserMessage({ provider: ProviderType.OPENAI, content: 'question' }),
        createToolCallMessage({ provider: ProviderType.OPENAI, id: 'call_1', name: 'read_file', args: {} }),
        /** @type {any} */ ({ role: 'tool', tool_call_id: 'call_1', content: 'file body' }),
        createUserMessage({ provider: ProviderType.OPENAI, content: 'next question' }),
    ];
    const notification = createAssistantMessage({ provider: ProviderType.OPENAI, content: '[Subagent "explore" finished]\ndone' });
    const out = interleavePendingRows({ rows: answered, pending: [notification] });
    assert.equal(out.filter((/** @type {any} */ m) => m.role === 'tool').length, 1, 'no second result for an answered call');
    assert.equal(out.length, 5, 'the notification is the only row added');

    // A round the conversation already moved past is not reopened: a late result
    // for it would be invalid ordering, not a repair.
    const movedOn = [
        createUserMessage({ provider: ProviderType.OPENAI, content: 'question' }),
        createToolCallMessage({ provider: ProviderType.OPENAI, id: 'call_9', name: 'read_file', args: {} }),
        createAssistantMessage({ provider: ProviderType.OPENAI, content: 'I moved on.' }),
        createUserMessage({ provider: ProviderType.OPENAI, content: 'next question' }),
    ];
    const after = interleavePendingRows({ rows: movedOn, pending: [notification] });
    assert.equal(after.filter((/** @type {any} */ m) => m.role === 'tool').length, 0, 'an old unanswered call is left alone');
});

// ─── N5: a continued turn streams like its first one ───

/** @param {{model: any, client: any, stream: boolean}} arg0 */
function streamSession({ model, client, stream }) {
    return /** @type {any} */ ({
        model,
        provider: ProviderType.OPENAI,
        client,
        eventEmitter: new EventEmitter(),
        _taskDepth: 0,
        _lastStepMessages: [],
        withSystemMessage() { return this; },
        withTools() { return this; },
        withRetryPolicy() { return this; },
        withHeaderTimeout() { return this; },
        withMaxElapsedMs() { return this; },
        withCircuitBreaker() { return this; },
        /** @param {{initialInput?: any[], options?: any}} [arg0] */
        async run({ initialInput = [], options } = {}) {
            if (stream) options?.onEvent?.({ type: 'text', content: 'continued work' });
            this.lastRunContext = options?.runContext ?? null;
            this._lastStepMessages = [...(this._lastStepMessages ?? []), ...initialInput,
                createAssistantMessage({ provider: ProviderType.OPENAI, content: 'child answer' })];
            Object.defineProperty(this, '_lastRunUsage', { value: { promptTokens: 10 }, configurable: true });
            return 'child answer';
        },
    });
}

test('N5/continue-stream: a continued spawn forwards its stream to the parent emitter', async () => {
    /** @type {any} */
    const client = {
        provider: ProviderType.OPENAI,
        sessions: [],
        emit: () => false,
        /** @param {string} model */
        session(model) {
            const s = streamSession({ model, client, stream: true });
            client.sessions.push(s);
            return s;
        },
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const parent = parentSession(client);
    const parentCtx = new RunContext({ runId: 'parent-run' });
    const tool = /** @type {any} */ (createTaskTool({ session: parent }));
    await tool.execute({ args: { prompt: 'Do X', subagent_type: 'worker' }, context: { runContext: parentCtx } });
    const [spawn] = listSpawns({ client });
    /** @type {any[]} */
    const events = [];
    /** @type {any[]} */
    const toolEvents = [];
    /** @type {any[]} */
    const finishes = [];
    parent.eventEmitter.on('workflow:step_text', (/** @type {any} */ e) => events.push(e));
    parent.eventEmitter.on('workflow:step_tool_call_start', (/** @type {any} */ e) => toolEvents.push(e));
    parent.eventEmitter.on('task:finish', (/** @type {any} */ e) => finishes.push(e));

    await spawn.continueWith({ prompt: 'Keep going.' });
    assert.ok(events.length >= 1, 'the continued turn streamed');
    assert.equal(events.at(-1).subagent, 'worker', 'the event names the child');
    assert.equal(events.at(-1).stepId, spawn.id, 'and the spawn, since a continuation has no step');
    assert.equal(events.at(-1).runId, 'parent-run', 'the event is correlated to the spawning step');
    assert.equal(toolEvents.length, 0, 'no tool events were invented');
    assert.equal(finishes.length, 1, 'the continuation settled once');
    assert.equal(finishes[0].runId, 'parent-run', 'its task event is stamped with the spawner, not dropped');
    const childCtx = spawn.session?.lastRunContext;
    assert.equal(childCtx?.parentRunId, 'parent-run', 'the continued run still hangs off the spawner');
    assert.notEqual(childCtx?.runId, 'parent-run', 'with its own run id');
});

test('N5/continue-listener: a throwing parent listener cannot break a continuation', async () => {
    /** @type {any} */
    const client = {
        provider: ProviderType.OPENAI,
        sessions: [],
        emit: () => false,
        /** @param {string} model */
        session(model) {
            const s = streamSession({ model, client, stream: true });
            client.sessions.push(s);
            return s;
        },
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const parent = parentSession(client);
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({
        args: { prompt: 'Do X', subagent_type: 'worker' },
    });
    const [spawn] = listSpawns({ client });
    parent.eventEmitter.on('workflow:step_text', () => { throw new Error('listener boom'); });
    const answer = await spawn.continueWith({ prompt: 'Keep going.' });
    assert.equal(answer, 'child answer', 'the continuation completed');
});
