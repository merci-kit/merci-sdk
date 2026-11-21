// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { createSaveArtifactTool } from '../lib/agentic/artifacts.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { ChatSession as JaiChatSession } from '../lib/backends/jai.mjs';
import { AgentContext } from '../lib/agentic/agent-context.mjs';
import { runObjectivePass, normalizeObjectivePolicy } from '../lib/agentic/objective.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { AbortedError } from '../lib/core/errors.mjs';

/** @type {any} */
const stubProfileManager = {
    getProfile() { return null; },
    isSupported() { return true; },
};

// ── C3: withParameters merges ────────────────────────────────────────────────

test('C3: withParameters merges across calls (OAI)', () => {
    const session = new OaiChatSession({ client: {}, model: 'gpt-4o-mini', eventEmitter: new EventEmitter() });
    session.withParameters({ params: { temperature: 0.5 } });
    session.withParameters({ params: { topP: 0.9 } });
    assert.equal((/** @type {any} */ (session._parameters)).temperature, 0.5, 'earlier key survives');
    assert.equal((/** @type {any} */ (session._parameters)).top_p, 0.9, 'later key wins');
});

test('C3: withParameters merges across calls (JAI)', () => {
    const session = new JaiChatSession({ httpClient: /** @type {any} */ ({}), profile: 'jai-gpt-4o', eventEmitter: new EventEmitter(), profileManager: stubProfileManager });
    session.withParameters({ params: { temperature: 0.4 } });
    session.withParameters({ params: { topP: 0.95 } });
    assert.equal((/** @type {any} */ (session._jaiSpec)).TEMPERATURE, 0.4, 'earlier V9 key survives');
    assert.equal((/** @type {any} */ (session._jaiSpec)).TOP_P, 0.95, 'later V9 key wins');
    assert.equal((/** @type {any} */ (session._parameters)).temperature, 0.4);
    assert.equal((/** @type {any} */ (session._parameters)).topP, 0.95);
});

test('C3: withWebSearch({force:true}) after withParameters keeps the earlier params', () => {
    const session = new OaiChatSession({ client: {}, model: 'gpt-4o-mini', eventEmitter: new EventEmitter() });
    session.withParameters({ params: { temperature: 0.5 } });
    session.withWebSearch({ options: { force: true } });
    assert.equal((/** @type {any} */ (session._parameters)).temperature, 0.5, 'force must not wipe existing params');
});

// ── C4: terminal run:end on failure + sessionId ─────────────────────────────

/**
 * @param {{failure: Error|null, signal?: AbortSignal}} arg0
 */
function failingSession({ failure, signal }) {
    const emitter = new EventEmitter();
    const session = {
        provider: 'OAI',
        model: 'm',
        sessionId: 'sess-42',
        _tools: [],
        eventEmitter: emitter,
        async *step() {
            if (failure) throw failure;
            return { done: true, content: 'ok', messages: [{ role: 'assistant', content: 'ok' }] };
        },
    };
    void signal;
    return session;
}

test('C4: a throwing run emits run:end { finishReason: error } exactly once, with sessionId', async () => {
    const session = failingSession({ failure: new Error('boom') });
    /** @type {any[]} */
    const ends = [];
    /** @type {any[]} */
    const starts = [];
    session.eventEmitter.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => ends.push(e));
    session.eventEmitter.on(EVENTS.CLIENT.RUN_START, (/** @type {any} */ e) => starts.push(e));
    await assert.rejects(runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] }), /boom/);
    assert.equal(ends.length, 1, 'exactly one terminal run:end');
    assert.equal(ends[0].finishReason, 'error');
    assert.equal(ends[0].sessionId, 'sess-42');
    assert.equal(starts[0].sessionId, 'sess-42', 'run:start carries the session id too');
});

test('C4: an aborted run emits run:end { finishReason: aborted }', async () => {
    const ac = new AbortController();
    ac.abort(new Error('user cancel'));
    const session = failingSession({ failure: null, signal: ac.signal });
    /** @type {any[]} */
    const ends = [];
    session.eventEmitter.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => ends.push(e));
    await assert.rejects(
        runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: { signal: ac.signal } }),
        AbortedError
    );
    assert.equal(ends.length, 1);
    assert.equal(ends[0].finishReason, 'aborted');
    assert.equal(ends[0].sessionId, 'sess-42');
});

test('C4: a successful run carries sessionId on run:start/run:end', async () => {
    const session = failingSession({ failure: null });
    /** @type {any[]} */
    const ends = [];
    session.eventEmitter.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => ends.push(e));
    assert.equal(await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] }), 'ok');
    assert.equal(ends[0].finishReason, 'stop');
    assert.equal(ends[0].sessionId, 'sess-42');
});

// ── C9: the step generator is closed on abnormal exit ────────────────────────

test('C9: an abort mid-tool-round closes the step generator (no abort listeners leak)', async () => {
    const controller = new AbortController();
    let closed = false;
    const session = {
        provider: 'OAI',
        model: 'm',
        _tools: [{
            name: 'blocker',
            parameters: { type: 'object', properties: {} },
            execute: () => { controller.abort(); return new Promise(() => {}); },
        }],
        eventEmitter: new EventEmitter(),
        /** @param {{messages: *, options: *}} arg0 */
        async *step({ messages, options }) {
            const onAbort = () => {};
            options.signal.addEventListener('abort', onAbort);
            try {
                yield { type: 'tool_request', calls: [{ id: 'c1', name: 'blocker', arguments: '{}' }] };
                yield { type: 'text', content: 'never reached' };
            } finally {
                options.signal.removeEventListener('abort', onAbort);
                closed = true;
            }
        },
    };
    await assert.rejects(
        runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: { signal: controller.signal } }),
        AbortedError
    );
    assert.equal(closed, true, 'the step generator must be closed via gen.return()');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'no abort listener may survive');
});

// ── C10: save_artifact manifest race ─────────────────────────────────────────

test('C10: parallel saves produce two files and two manifest entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-artifacts-race-'));
    try {
        const tool = /** @type {any} */ (createSaveArtifactTool({ dir }));
        const paths = await Promise.all([
            tool.execute({ args: { name: 'a.md', content: 'AAA' } }),
            tool.execute({ args: { name: 'b.md', content: 'BBB' } }),
        ]);
        assert.equal(new Set(paths).size, 2, 'two distinct files');
        const manifest = JSON.parse(readFileSync(join(dir, '.artifacts.json'), 'utf8'));
        assert.equal(manifest.entries.length, 2, 'both saves must land in the manifest');
        assert.deepEqual(manifest.entries.map((/** @type {any} */ e) => e.name).sort(), ['a.md', 'b.md']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ── C11: mid-stream errors are forwarded to orchestrators ────────────────────

test('C11: a mid-stream error emits a run-scoped error:thrown event', async () => {
    const emitter = new EventEmitter();
    const session = {
        provider: 'OAI',
        model: 'm',
        _tools: [],
        eventEmitter: emitter,
        async *step() {
            yield { type: 'error', error_message: 'content filter', error_type: 'safety' };
            return {
                done: true,
                content: 'partial',
                messages: [{ role: 'assistant', content: 'partial' }],
                streamError: { type: 'error', error_message: 'content filter', error_type: 'safety' },
            };
        },
    };
    /** @type {any[]} */
    const errors = [];
    emitter.on(EVENTS.ERRORS.THROWN, (/** @type {any} */ e) => errors.push(e));
    // B-5: the mid-stream failure is thrown, so the run-level retry policy and
    // every caller see a failure instead of a sentinel answer.
    await assert.rejects(runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] }), /content filter/);
    assert.equal(errors.length, 1, 'the stream error must reach orchestrators');
    assert.equal(errors[0].code, 'safety', 'the vendor error type is the code');
    assert.equal(typeof errors[0].runId, 'string', 'run-scoped correlation');
    assert.match(errors[0].message, /content filter/);
});

// ── C12: callbacks receive the signal ────────────────────────────────────────

test('C12: followUp receives the caller signal', async () => {
    const controller = new AbortController();
    let seenSignal = null;
    const session = {
        provider: 'OAI',
        model: 'm',
        _tools: [],
        eventEmitter: new EventEmitter(),
        /** @param {{messages: *}} arg0 */
        async *step({ messages }) {
            return { done: true, content: 'answer', messages: [...messages, { role: 'assistant', content: 'answer' }] };
        },
    };
    const out = await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: {
        signal: controller.signal,
        followUp: /** @type {(...args: any[]) => any} */ ((info) => { seenSignal = info.signal; return null; }),
    } });
    assert.equal(out, 'answer');
    assert.equal(seenSignal, controller.signal, 'the followUp payload must carry the caller signal');
});

test('C12: onIterationStart and onLimitReached receive the signal', async () => {
    const controller = new AbortController();
    /** @type {any[]} */
    const iterationSignals = [];
    /** @type {any[]} */
    const limitSignals = [];
    const session = {
        provider: 'OAI',
        model: 'm',
        _tools: [],
        eventEmitter: new EventEmitter(),
        /** @param {{messages: *}} arg0 */
        async *step({ messages }) {
            return {
                done: false,
                messages: [...messages, { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }] }],
            };
        },
    };
    await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }], opts: {
        maxIterations: 1,
        signal: controller.signal,
        onIterationStart: (/** @type {any} */ arg) => { iterationSignals.push(arg); },
        onLimitReached: (/** @type {any} */ info) => { limitSignals.push(info.signal); return false; },
        errorHandlers: { max_turns: () => 'stop' },
    } });
    assert.equal(iterationSignals[0]?.signal, controller.signal, 'onIterationStart must receive the signal');
    assert.equal(typeof iterationSignals[0]?.i, 'number', 'onIterationStart must receive a numeric `i`');
    assert.equal(typeof iterationSignals[0]?.globalIteration, 'number', 'onIterationStart must receive a numeric `globalIteration`');
    assert.equal(typeof iterationSignals[0]?.iterMax, 'number', 'onIterationStart must receive a numeric `iterMax`');
    assert.equal(limitSignals[0], controller.signal, 'onLimitReached must receive the signal');
});

// ── C14: builder composition keeps skill tools ───────────────────────────────

test('C14: withTools after withSkills keeps the skill tool advertised', () => {
    const builder = new ChatSessionBuilder();
    const skill = { name: 'skill_tool', description: 'a skill', parameters: { type: 'object', properties: {} } };
    builder.withSkills({ skills: [skill] });
    builder.withTools({ tools: [{ name: 'user_tool', description: 'user', parameters: { type: 'object', properties: {} } }] });
    const names = builder._tools.map((/** @type {any} */ t) => t && t.name);
    assert.ok(names.includes('user_tool'), 'user tools are advertised');
    assert.ok(names.includes('skill_tool'), 'a later withTools must not drop skill tools');
    assert.ok(names.includes('load_skills'), 'the load_skills capability tool stays');
});

// ── C15: objective restatement is serialized per context ─────────────────────

test('C15: two concurrent passes on one context coalesce into one restatement', async () => {
    let restates = 0;
    const client = {
        session: () => ({
            run: async () => { restates++; await new Promise((r) => setTimeout(r, 10)); return 'RESTATED'; },
        }),
    };
    const ctx = new AgentContext({
        objective: 'ORIGINAL',
        objectivePolicy: normalizeObjectivePolicy({ opts: { firstUpdate: 1, updateTurns: 1 } }),
    });
    const outcomes = await Promise.all([
        runObjectivePass({ p: { ctx, client, model: 'm' } }),
        runObjectivePass({ p: { ctx, client, model: 'm' } }),
    ]);
    assert.equal(restates, 1, 'the underlying restate call must run once');
    assert.equal(ctx.objectiveVersion, 1, 'the version increments once');
    assert.equal(/** @type {any} */ (outcomes[0]).applied, true);
    assert.equal(/** @type {any} */ (outcomes[1]).applied, true, 'the joined caller sees the applied outcome');
});

// ─── J4 (Phase 2D residual): one retry owner per failure class ──────────────

test('J4: a transport error marked nonRetryable is not retried at the run level', async () => {
    const err = Object.assign(new Error('gateway exhausted its own retries'), { status: 503, nonRetryable: true });
    let calls = 0;
    /** @type {any} */
    const session = {
        provider: 'OAI',
        model: 'm',
        _tools: [],
        eventEmitter: { emit: () => {} },
        async *step() {
            calls++;
            throw err;
        },
    };
    const { ExponentialBackoffPolicy } = await import('../lib/support/retry-policy.mjs');
    const { createUserMessage } = await import('../lib/messaging/messages.mjs');
    await assert.rejects(
        runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: {
            retryPolicy: new ExponentialBackoffPolicy({ maxRetries: 3, initialDelayMs: 1, maxDelayMs: 2, jitterMs: 0 }),
        } }),
        /gateway exhausted/,
    );
    assert.equal(calls, 1, 'the transport already spent the retry budget');
});
