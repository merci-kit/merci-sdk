// @ts-check

/**
 * Wave 6 / SP3 — continue a child.
 *
 * A spawn is a live session: `continueWith(prompt)` (and `client.send({id,
 * prompt})`) runs another turn on the SAME conversation, and a background result
 * lands in the parent's conversation when it settles.
 *
 * Check-first: written before the continuation exists.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
    withTaskAgents, createTaskTool, continueSpawn, sendToSpawn,
} from '../lib/agentic/task.mjs';
import { listSpawns, getSpawn, getSpawnRegistry as getSpawnRegistryOf } from '../lib/agentic/spawn-registry.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

/** @returns {any} */
function makeClient() {
    /** @type {any[]} */
    const sessions = [];
    /** @type {any[][]} */
    const seen = [];
    const client = {
        provider: 'openai',
        sessions,
        seen,
        emit: () => false,
        /** @param {string} model */
        session(model) {
            /** @type {any} */
            const s = {
                provider: 'openai',
                model,
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
                /** @param {{initialInput?: any[]}} [arg0] */
                async run({ initialInput = [] } = {}) {
                    seen.push(initialInput.map((m) => String(m?.content ?? '')));
                    // Keep the conversation the way a real session does.
                    s._lastStepMessages = [...(s._lastStepMessages ?? []), ...initialInput,
                        { role: 'assistant', content: `answer ${seen.length}` }];
                    Object.defineProperty(s, '_lastRunUsage', {
                        value: { promptTokens: 10 }, configurable: true,
                    });
                    return `answer ${seen.length}`;
                },
                /** @param {{messages?: any[]}} [arg0] */
                async step({ messages } = {}) {
                    const input = messages ?? [];
                    const answer = await s.run({ initialInput: input });
                    return { done: true, content: answer, messages: s._lastStepMessages, thoughtSignature: null };
                },
            };
            sessions.push(s);
            return s;
        },
    };
    return client;
}

/** @param {any} client @returns {any} */
const parentSession = (client) => {
    /** @type {any} */
    const parent = {
        client,
        model: 'parent-model',
        provider: 'openai',
        eventEmitter: new EventEmitter(),
        _taskDepth: 0,
        _lastStepMessages: [createUserMessage({ provider: 'openai', content: 'root question' })],
        /** @param {{initialInput?: any[]}} [arg0] */
        async run({ initialInput = [] } = {}) {
            parent.lastInitialInput = initialInput;
            return { result: 'parent answer', messages: initialInput, deltaMessages: [], signature: null, provider: 'openai', usage: null };
        },
    };
    return parent;
};

/** @param {any} client @returns {Promise<any>} */
async function firstSpawn(client) {
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    await /** @type {any} */ (createTaskTool({ session: parentSession(client) })).execute({
        args: { prompt: 'Do X', subagent_type: 'explore' },
    });
    const [spawn] = listSpawns({ client });
    return spawn;
}

test('W6/continue-turn: continueWith runs another turn on the SAME session', async () => {
    const client = makeClient();
    const spawn = await firstSpawn(client);
    const session = spawn.session;
    assert.ok(session, 'the spawn kept its session');
    const reply = await spawn.continueWith({ prompt: 'Now focus on auth.' });
    assert.equal(reply, 'answer 2', 'the continuation produced a second answer');
    assert.equal(client.sessions.length, 1, 'no new session was built');
    assert.equal(spawn.session, session, 'the same session object');
    const lastInput = client.seen.at(-1);
    assert.ok(lastInput.some((/** @type {string} */ t) => t.includes('Now focus on auth.')), 'the new prompt reached it');
});

test('W6/continue-history: the child keeps its own conversation across turns', async () => {
    const client = makeClient();
    const spawn = await firstSpawn(client);
    await spawn.continueWith({ prompt: 'Second question.' });
    const history = client.seen.at(-1).join('\n');
    assert.ok(history.includes('Do X'), 'the first turn is still in the child conversation');
    assert.ok(history.includes('Second question.'));
});

test('W6/continue-usage: continuation spend adds to the spawn ledger', async () => {
    const client = makeClient();
    const spawn = await firstSpawn(client);
    const before = spawn.usage?.promptTokens ?? 0;
    await spawn.continueWith({ prompt: 'More work.' });
    assert.equal(spawn.usage?.promptTokens, before + 10, 'the second turn is charged too');
});

test('W6/continue-status: a continuation reopens and re-settles the record', async () => {
    const client = makeClient();
    const spawn = await firstSpawn(client);
    assert.equal(spawn.status, 'done');
    const firstFinished = spawn.finishedAt;
    const reply = await spawn.continueWith({ prompt: 'Again.' });
    assert.equal(reply, 'answer 2');
    assert.equal(spawn.status, 'done', 'settled again');
    assert.equal(spawn.settles, 2, 'the record settled for a second turn');
    assert.ok(spawn.finishedAt, 'with a completion time');
    assert.equal(typeof firstFinished, 'string');
});

test('W6/send: client.send({id, prompt}) addresses a live child', async () => {
    const client = makeClient();
    const spawn = await firstSpawn(client);
    const reply = await sendToSpawn({ client, id: spawn.id, prompt: 'From the parent.' });
    assert.equal(reply, 'answer 2');
    assert.ok(client.seen.at(-1).some((/** @type {string} */ t) => t.includes('From the parent.')));
});

test('W6/send-unknown: an unknown spawn id fails loudly', async () => {
    const client = makeClient();
    await assert.rejects(
        () => sendToSpawn({ client, id: 'sub_nope', prompt: 'x' }),
        /no spawn with id "sub_nope"/,
    );
});

test('W6/continue-code-agent: a code-agent spawn has no session to continue', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'coder', execute: async () => 'code-ok' }] });
    await /** @type {any} */ (createTaskTool({ session: parentSession(client) })).execute({
        args: { prompt: 'Do X', subagent_type: 'coder' },
    });
    const [spawn] = listSpawns({ client });
    await assert.rejects(
        () => spawn.continueWith({ prompt: 'Again.' }),
        /cannot continue a spawn with no session/,
    );
});

test('W6/continue-error: a failed continuation records the error and keeps the id', async () => {
    const client = makeClient();
    const spawn = await firstSpawn(client);
    const session = spawn.session;
    session.run = async () => { throw new Error('turn failed'); };
    await assert.rejects(() => spawn.continueWith({ prompt: 'Boom.' }), /turn failed/);
    assert.equal(spawn.status, 'error');
    assert.match(String(spawn.error), /turn failed/);
    assert.equal(getSpawn({ client, id: spawn.id })?.status, 'error');
});

test('W6/background-appended: a background result lands in the parent conversation', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    const parent = parentSession(client);
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({
        args: { prompt: 'Do X', subagent_type: 'explore', background: true },
    });
    const [spawn] = listSpawns({ client });
    await spawn.wait();
    await new Promise((r) => setTimeout(r, 10));
    // The result waits in an inbox (the loop owns `_lastStepMessages`) and is
    // drained into the parent's NEXT turn.
    const inbox = parent._pendingInputRows ?? [];
    assert.equal(inbox.length, 1, 'exactly one row is queued');
    assert.ok(String(inbox[0].content).includes('answer 1'), 'it carries the child result');

    const { runStep } = await import('../lib/agentic/step.mjs');
    await runStep({ step: { name: 'parent', model: 'parent-model' }, deps: {
        session: parent,
        messages: [createUserMessage({ provider: 'openai', content: 'next question' })],
        maxIterations: 1,
        configureSession: false,
    } });
    const sent = (parent.lastInitialInput ?? []).map((/** @type {any} */ m) => String(m.content ?? '')).join('\n');
    assert.ok(sent.includes('answer 1'), 'the next parent turn carries the child result');
    assert.ok(sent.includes('next question'), 'and the new prompt');
    assert.equal((parent._pendingInputRows ?? []).length, 0, 'the inbox was drained once');
});

// ─── Findings from the independent SP3 verifier ─────────────────────────────

test('W6/continue-string: the documented string form is accepted', async () => {
    const client = makeClient();
    const spawn = await firstSpawn(client);
    const reply = await spawn.continueWith('Plain string prompt.');
    assert.equal(reply, 'answer 2', 'the string form runs a turn');
    assert.ok(client.seen.at(-1).some((/** @type {string} */ t) => t.includes('Plain string prompt.')),
        'the string becomes the prompt, not an empty row');
});

test('W6/continue-concurrent: a second turn waits for the running one', async () => {
    const client = makeClient();
    const spawn = await firstSpawn(client);
    const session = spawn.session;
    const original = session.run;
    let releases = 0;
    session.run = async (/** @type {any} */ args) => {
        await new Promise((r) => setTimeout(r, 20));
        releases += 1;
        return original(args);
    };
    const [a, b] = await Promise.all([
        spawn.continueWith({ prompt: 'A' }),
        spawn.continueWith({ prompt: 'B' }),
    ]);
    assert.equal(a, 'answer 2');
    assert.equal(b, 'answer 3');
    assert.equal(releases, 2, 'the two turns did not interleave');
    const rows = session._lastStepMessages.map((/** @type {any} */ m) => String(m.content ?? ''));
    assert.equal(rows.filter((/** @type {string} */ t) => t === 'A').length, 1, 'A appears once');
    assert.equal(rows.filter((/** @type {string} */ t) => t === 'B').length, 1, 'B appears once');
});

test('W6/continue-after-failure: a failed turn keeps the conversation for the next one', async () => {
    const client = makeClient();
    const spawn = await firstSpawn(client);
    const session = spawn.session;
    const good = session.run;
    session.run = async () => { throw new Error('turn failed'); };
    await assert.rejects(() => spawn.continueWith({ prompt: 'Boom.' }), /turn failed/);
    session.run = good;
    await spawn.continueWith({ prompt: 'Retry.' });
    const sent = client.seen.at(-1).join('\n');
    assert.ok(sent.includes('Do X'), 'the first turn survived the failure');
    assert.ok(sent.includes('Retry.'));
});

test('W6/continue-same-config: a continuation never re-applies the child config', async () => {
    const client = makeClient();
    const spawn = await firstSpawn(client);
    const session = spawn.session;
    let systemCalls = 0;
    let toolCalls = 0;
    const withSystem = session.withSystemMessage;
    const withTools = session.withTools;
    session.withSystemMessage = (/** @type {any} */ m) => { systemCalls += 1; return withSystem(m); };
    session.withTools = (/** @type {any} */ a) => { toolCalls += 1; return withTools(a); };
    await spawn.continueWith({ prompt: 'Again.' });
    assert.equal(systemCalls, 0, 'the system prompt is not rebuilt');
    assert.equal(toolCalls, 0, 'the tools are not rebuilt');
});

test('W6/continue-usable: an empty continuation output fails the turn', async () => {
    const client = makeClient();
    const spawn = await firstSpawn(client);
    spawn.session.run = async () => '';
    await assert.rejects(() => spawn.continueWith({ prompt: 'Say nothing.' }), /no usable output/);
});

test('W6/continue-exported: the continuation API is reachable from the package entry', async () => {
    const sdk = /** @type {any} */ (await import('../lib/index.mjs'));
    assert.equal(typeof sdk.continueSpawn, 'function');
    assert.equal(typeof sdk.sendToSpawn, 'function');
});

test('W6/background-tool-tail: a tool-round tail keeps the result and the round is closed before it (wave 11 / N4)', async () => {
    // A tail that is a dangling CALL: the notification cannot sit right after it.
    /** @type {any[]} */
    const tails = [
        { role: 'assistant', content: 'calling', tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }] },
    ];
    const { interleavePendingRows } = await import('../lib/agentic/pending-inbox.mjs');
    for (const tail of tails) {
        const client = makeClient();
        withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
        const parent = parentSession(client);
        parent._lastStepMessages = [createUserMessage({ provider: 'openai', content: 'go' }), tail];
        await /** @type {any} */ (createTaskTool({ session: parent })).execute({
            args: { prompt: 'Do X', subagent_type: 'explore', background: true },
        });
        const [spawn] = listSpawns({ client });
        await spawn.wait();
        await new Promise((r) => setTimeout(r, 5));
        const inbox = parent._pendingInputRows ?? [];
        assert.equal(inbox.length, 1, `the result is queued on a ${String(tail.type ?? tail.role)} tail`);
        const out = interleavePendingRows({
            rows: [...parent._lastStepMessages, createUserMessage({ provider: 'openai', content: 'next' })],
            pending: inbox,
        });
        const noticeAt = out.findIndex((/** @type {any} */ m) => String(m.content ?? '').includes('Subagent'));
        const resultAt = out.findIndex((/** @type {any} */ m) => m.role === 'tool' && m.tool_call_id === 'c1');
        assert.ok(resultAt >= 0, 'the unanswered call got a synthetic result');
        assert.ok(noticeAt > resultAt, 'and the notification lands after it');
    }
});

test('W6/continue-queue: three concurrent turns run one after another, no row duplication', async () => {
    const client = makeClient();
    const spawn = await firstSpawn(client);
    const session = spawn.session;
    const original = session.run;
    session.run = async (/** @type {any} */ args) => {
        await new Promise((r) => setTimeout(r, 15));
        return original(args);
    };
    await Promise.all([
        spawn.continueWith({ prompt: 'A' }),
        spawn.continueWith({ prompt: 'B' }),
        spawn.continueWith({ prompt: 'C' }),
    ]);
    const rows = session._lastStepMessages.map((/** @type {any} */ m) => String(m.content ?? ''));
    for (const prompt of ['A', 'B', 'C']) {
        assert.equal(rows.filter((/** @type {string} */ t) => t === prompt).length, 1, `${prompt} appears once`);
    }
    assert.equal(spawn.usage?.promptTokens, 40, 'four turns are charged');
});

test('W6/background-tool-tail-extra: answered tails get no synthetic result; GAI/JAI calls are closed (wave 11 / N4)', async () => {
    const { interleavePendingRows } = await import('../lib/agentic/pending-inbox.mjs');
    /** @param {any} m @returns {boolean} */
    const isResult = (m) => m?.role === 'tool'
        || m?.type === 'tool_message'
        || (Array.isArray(m?.parts) && m.parts.some((/** @type {any} */ p) => p?.functionResponse))
        || (Array.isArray(m?.content) && m.content.some((/** @type {any} */ b) => b?.type === 'tool_result'));
    /** @type {Array<{tail: any, closing: boolean}>} */
    const cases = [
        { tail: { type: 'tool_message', id: 'c1', toolName: 'x', result: 'ok' }, closing: false },
        { tail: { role: 'tool', tool_call_id: 'c1', content: 'ok' }, closing: false },
        { tail: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] }, closing: false },
        { tail: { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'x', response: {} } }] }, closing: false },
        { tail: { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'x', args: {} } }] }, closing: true },
        { tail: { type: 'assistant_message_tool', id: 'c1', toolName: 'x', content: '{}' }, closing: true },
    ];
    for (const { tail, closing } of cases) {
        const client = makeClient();
        withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
        const parent = parentSession(client);
        parent._lastStepMessages = [createUserMessage({ provider: 'openai', content: 'go' }), tail];
        await /** @type {any} */ (createTaskTool({ session: parent })).execute({
            args: { prompt: 'Do X', subagent_type: 'explore', background: true },
        });
        const [spawn] = listSpawns({ client });
        await spawn.wait();
        await new Promise((r) => setTimeout(r, 5));
        const inbox = parent._pendingInputRows ?? [];
        assert.equal(inbox.length, 1, `the result is queued on a ${String(tail.type ?? tail.role)} tail`);
        const rows = [...parent._lastStepMessages, createUserMessage({ provider: 'openai', content: 'next' })];
        const out = interleavePendingRows({ rows, pending: inbox });
        assert.equal(out.length, rows.length + 1 + (closing ? 1 : 0),
            closing ? 'a dangling call is closed with one synthetic result' : 'an answered tail gets no second result');
        assert.ok(out.includes(tail), 'the parent rows survive as they were');
        if (closing) assert.ok(out.some((/** @type {any} */ m) => isResult(m) && m !== tail), 'the synthetic result closes the call');
        assert.ok(String(out.at(-1)?.content ?? '').includes('next'), 'the prompt stays last');
    }
});

test('W6/background-inbox-survives-failure: a failed parent turn keeps the queued result', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    const parent = parentSession(client);
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({
        args: { prompt: 'Do X', subagent_type: 'explore', background: true },
    });
    const [spawn] = listSpawns({ client });
    await spawn.wait();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((parent._pendingInputRows ?? []).length, 1);

    const good = parent.run;
    parent.run = async () => { throw new Error('parent turn failed'); };
    const { runStep } = await import('../lib/agentic/step.mjs');
    await assert.rejects(() => runStep({ step: { name: 'p', model: 'parent-model' }, deps: {
        session: parent,
        messages: [createUserMessage({ provider: 'openai', content: 'doomed' })],
        maxIterations: 1,
        configureSession: false,
    } }));
    assert.equal((parent._pendingInputRows ?? []).length, 1, 'the queued result was not consumed by the failure');
    parent.run = good;
    await runStep({ step: { name: 'p', model: 'parent-model' }, deps: {
        session: parent,
        messages: [createUserMessage({ provider: 'openai', content: 'recovery' })],
        maxIterations: 1,
        configureSession: false,
    } });
    const sent = (parent.lastInitialInput ?? []).map((/** @type {any} */ m) => String(m.content ?? '')).join('\n');
    assert.ok(sent.includes('answer 1'), 'the next successful turn carries it');
    assert.equal((parent._pendingInputRows ?? []).length, 0, 'and consumes it once');
});

test('W6/inbox-direct-run: session.run drains the inbox for a host that skips runStep', async () => {
    const { ChatSession } = await import('../lib/backends/oai.mjs');
    const { getSpawnRegistry } = await import('../lib/agentic/spawn-registry.mjs');
    const client = makeClient();
    const session = new ChatSession({ client, model: 'm', eventEmitter: client });
    /** @type {any[]} */
    let seen = [];
    // Stub the turn so no vendor call is made; the drain happens above it.
    /** @type {any} */ (session)._runOnce = async (/** @type {any} */ { initialInput }) => {
        seen = /** @type {any[]} */ (initialInput);
        return 'ok';
    };
    /** @type {any} */ (session)._pendingInputRows = [{ role: 'assistant', content: '[Subagent "x" finished]\nlate result' }];
    await session.run({ initialInput: [createUserMessage({ provider: 'openai', content: 'next' })] });
    const text = seen.map((/** @type {any} */ m) => String(m.content ?? '')).join('\n');
    assert.ok(text.includes('late result'), 'the queued row reached a direct run');
    assert.equal((/** @type {any} */ (session)._pendingInputRows ?? []).length, 0, 'and was consumed');
    getSpawnRegistry({ client });
});

test('W6/continue-error-event: a failed continuation emits task:error', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    const parent = parentSession(client);
    /** @type {any[]} */
    const errors = [];
    parent.eventEmitter.on('task:error', (/** @type {any} */ e) => errors.push(e));
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({
        args: { prompt: 'Do X', subagent_type: 'explore' },
    });
    const [spawn] = listSpawns({ client });
    assert.ok(spawn.session);
    spawn.session.run = async () => { throw new Error('turn failed'); };
    await assert.rejects(() => spawn.continueWith({ prompt: 'Boom.' }), /turn failed/);
    assert.equal(errors.length, 1, 'the host hears about the failure');
    const payload = errors[0]?.payload ?? errors[0] ?? {};
    assert.match(String(payload.error ?? ''), /turn failed/, 'with the message');
});

test('W6/continue-direct-spawn: a spawn opened by runTaskChild is continuable', async () => {
    const { runTaskChild } = await import('../lib/agentic/task.mjs');
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = parentSession(client);
    const profile = /** @type {any} */ (getSpawnRegistryOf({ client })).agents.get('worker');
    await runTaskChild({ session, profile, args: { description: 'x', prompt: 'Do X', subagent_type: 'worker' }, signal: undefined, eventEmitter: session.eventEmitter });
    const [spawn] = listSpawns({ client });
    const reply = await spawn.continueWith({ prompt: 'Carry on.' });
    assert.ok(reply, 'the MAA/direct spawn can be continued');
    assert.ok(client.seen.at(-1).some((/** @type {string} */ t) => t.includes('Carry on.')));
});

// ─── Findings from the SP3 re-verification (round 3) ────────────────────────

test('W6/continue-during-first-turn: a continuation chains from the first turn promise', async () => {
    const client = makeClient();
    const spawn = await firstSpawn(client);
    const registry = getSpawnRegistryOf({ client });
    const record = registry.spawns.get(spawn.id);
    assert.ok(record);
    // Simulate the first turn still being in flight: no queue yet, a live promise.
    record.turnQueue = undefined;
    record.status = 'running';
    // Deterministic: release the in-flight turn explicitly and assert the
    // continuation has NOT settled before that. The old `elapsed >= 35` passed
    // whenever the timer happened to fire late enough, and failed when it did not.
    /** @type {(v?: any) => void} */
    let releaseFirst = () => {};
    record.promise = new Promise((r) => { releaseFirst = r; });
    let settled = false;
    const pending = spawn.continueWith({ prompt: 'Second.' }).then((/** @type {any} */ v) => { settled = true; return v; });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(settled, false, 'the continuation waits for the in-flight turn');
    releaseFirst(spawn.result);
    const reply = await pending;
    assert.ok(reply, 'and then ran');
});

test('W6/direct-run-string: a string turn keeps its question when the inbox drains', async () => {
    const { ChatSession } = await import('../lib/backends/oai.mjs');
    const client = makeClient();
    const session = new ChatSession({ client, model: 'm', eventEmitter: client });
    /** @type {any[]} */
    let seen = [];
    /** @type {any} */ (session)._runOnce = async (/** @type {any} */ { initialInput }) => {
        seen = /** @type {any[]} */ (Array.isArray(initialInput)
            ? initialInput
            : [{ role: 'user', content: String(initialInput) }]);
        return 'ok';
    };
    /** @type {any} */ (session)._pendingInputRows = [{ role: 'assistant', content: 'LATE RESULT' }];
    await session.run({ initialInput: 'USER QUESTION' });
    const text = seen.map((/** @type {any} */ m) => String(m.content ?? '')).join('\n');
    assert.ok(text.includes('LATE RESULT'), 'the queued row rides along');
    assert.ok(text.includes('USER QUESTION'), 'and the question is not dropped');
});

test('W6/inbox-midrun: a row queued during the turn belongs to the next one', async () => {
    const client = makeClient();
    const parent = parentSession(client);
    const { runStep } = await import('../lib/agentic/step.mjs');
    const realRun = parent.run;
    /** @type {any} */
    const midRow = { role: 'assistant', content: 'ROW2-MIDRUN' };
    parent.run = async (/** @type {any} */ args) => {
        parent._pendingInputRows = [...(parent._pendingInputRows ?? []), midRow];
        return realRun(args);
    };
    parent._pendingInputRows = [{ role: 'assistant', content: 'ROW1-BEFORE' }];
    await runStep({ step: { name: 'p', model: 'parent-model' }, deps: {
        session: parent,
        messages: [
            createUserMessage({ provider: 'openai', content: 'root question' }),
            createUserMessage({ provider: 'openai', content: 'turn one' }),
        ],
        maxIterations: 1,
        configureSession: false,
    } });
    const left = parent._pendingInputRows ?? [];
    assert.equal(left.length, 1, 'only the consumed row was cleared');
    assert.equal(String(left[0].content), 'ROW2-MIDRUN', 'the mid-run row survives');
    const sent = (parent.lastInitialInput ?? []).map((/** @type {any} */ m) => String(m.content ?? ''));
    assert.ok(sent.includes('ROW1-BEFORE'), 'the queued row was sent');
    assert.ok(sent.indexOf('ROW1-BEFORE') < sent.indexOf('turn one'), 'before the new prompt');
    assert.ok(sent.indexOf('ROW1-BEFORE') > sent.indexOf('root question'),
        'and after the conversation history (a leading assistant row is not a valid request)');
});

test('W6/continue-listener-throw: a throwing listener cannot deadlock the chain', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    const parent = parentSession(client);
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({
        args: { prompt: 'Do X', subagent_type: 'explore' },
    });
    const [spawn] = listSpawns({ client });
    parent.eventEmitter.on('task:start', () => { throw new Error('listener boom'); });
    await spawn.continueWith({ prompt: 'One.' });
    const second = await spawn.continueWith({ prompt: 'Two.' });
    assert.ok(second, 'the chain still runs after a throwing listener');
    assert.equal(spawn.settles, 3, 'three turns settled');
});

test('W6/direct-run-failure-keeps-inbox: a failed direct turn does not drop the queued result', async () => {
    const { ChatSession } = await import('../lib/backends/oai.mjs');
    const client = makeClient();
    const session = new ChatSession({ client, model: 'm', eventEmitter: client });
    /** @type {any} */ (session)._runOnce = async () => { throw new Error('direct turn failed'); };
    /** @type {any} */ (session)._pendingInputRows = [{ role: 'assistant', content: 'LATE RESULT' }];
    await assert.rejects(() => session.run({ initialInput: 'USER QUESTION' }), /direct turn failed/);
    assert.equal((/** @type {any} */ (session)._pendingInputRows ?? []).length, 1, 'the queued row survives');
});

test('W6/inbox-no-history: a queued row folds into the prompt, never leads the request', async () => {
    const client = makeClient();
    const parent = parentSession(client);
    const { runStep } = await import('../lib/agentic/step.mjs');
    parent._pendingInputRows = [{ role: 'assistant', content: 'LATE RESULT' }];
    await runStep({ step: { name: 'p', model: 'parent-model' }, deps: {
        session: parent,
        messages: [createUserMessage({ provider: 'openai', content: 'only prompt' })],
        maxIterations: 1,
        configureSession: false,
    } });
    /** @type {any[]} */
    const sent = /** @type {any} */ (parent.lastInitialInput) ?? [];
    assert.equal(sent.length, 1, 'one user row, not an assistant row plus a prompt');
    assert.equal(sent[0].role, 'user', 'the request starts with the user');
    assert.ok(String(sent[0].content).includes('LATE RESULT'), 'the result is delivered');
    assert.ok(String(sent[0].content).includes('only prompt'), 'and the prompt survives');
    assert.equal((parent._pendingInputRows ?? []).length, 0, 'consumed once');
});

test('W6/inbox-no-history-direct: a direct string turn folds too', async () => {
    const { ChatSession } = await import('../lib/backends/oai.mjs');
    const client = makeClient();
    const session = new ChatSession({ client, model: 'm', eventEmitter: client });
    /** @type {any[]} */
    let seen = [];
    /** @type {any} */ (session)._runOnce = async (/** @type {any} */ { initialInput }) => {
        seen = /** @type {any[]} */ (initialInput);
        return 'ok';
    };
    /** @type {any} */ (session)._pendingInputRows = [{ role: 'assistant', content: 'LATE RESULT' }];
    await session.run({ initialInput: 'USER QUESTION' });
    assert.equal(seen.length, 1, 'one row');
    assert.equal(seen[0].role, 'user', 'user-first wire');
    assert.ok(String(seen[0].content).includes('LATE RESULT'));
    assert.ok(String(seen[0].content).includes('USER QUESTION'));
});

test('W6/inbox-empty-history: no user row at all delivers the result as a user row', async () => {
    const { interleavePendingRows } = await import('../lib/agentic/pending-inbox.mjs');
    const rows = interleavePendingRows({ rows: [], pending: [{ role: 'assistant', content: 'R' }] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, 'user', 'never an assistant-first request');
    assert.equal(rows[0].content, 'R');
});

test('W6/inbox-single-owner: step + run deliver the row exactly once', async () => {
    const { ChatSession } = await import('../lib/backends/oai.mjs');
    const client = makeClient();
    const session = new ChatSession({ client, model: 'm', eventEmitter: client });
    /** @type {any[]} */
    let seen = [];
    /** @type {any} */ (session)._runOnce = async (/** @type {any} */ { initialInput }) => {
        seen = /** @type {any[]} */ (initialInput);
        return 'answer';
    };
    /** @type {any} */ (session)._pendingInputRows = [{ role: 'assistant', content: 'ONE RESULT' }];
    const { runStep } = await import('../lib/agentic/step.mjs');
    await runStep({ step: { name: 'p', model: 'm' }, deps: {
        session,
        messages: [createUserMessage({ provider: 'openai', content: 'question' })],
        maxIterations: 1,
        configureSession: false,
    } });
    const text = seen.map((/** @type {any} */ m) => String(m.content ?? '')).join('\n');
    assert.equal(text.split('ONE RESULT').length - 1, 1, 'delivered once, not twice');
    assert.equal((/** @type {any} */ (session)._pendingInputRows ?? []).length, 0, 'consumed');
});

test('W6/inbox-parts: a Gemini/Vertex row (text in `parts`) is delivered', async () => {
    const { interleavePendingRows } = await import('../lib/agentic/pending-inbox.mjs');
    const prompt = { role: 'user', content: 'the prompt' };
    const rows = interleavePendingRows({ rows: [prompt], pending: [{ role: 'model', parts: [{ text: 'PARTS RESULT' }] }] });
    assert.equal(rows.length, 1, 'folded into the prompt');
    assert.ok(JSON.stringify(rows[0]).includes('PARTS RESULT'), 'the parts text is not lost');
    assert.ok(JSON.stringify(rows[0]).includes('the prompt'), 'the prompt survives');
    const empty = interleavePendingRows({ rows: [], pending: [{ role: 'model', parts: [{ text: 'PARTS RESULT' }] }] });
    assert.equal(empty[0].role, 'user', 'a lone row is delivered as a user row');
    // A raw Gemini/Vertex prompt row carries no `content`: the fold must land in `parts`.
    const gemini = interleavePendingRows({
        rows: [{ role: 'user', parts: [{ text: 'GEMINI QUESTION' }] }],
        pending: [{ role: 'model', parts: [{ text: 'LATE RESULT' }] }],
    });
    assert.ok(Array.isArray(gemini[0].parts), 'still a parts row');
    assert.ok(gemini[0].parts.map((/** @type {any} */ p) => p.text).join(' ').includes('LATE RESULT'), 'delivered in parts');
    assert.ok(gemini[0].parts.map((/** @type {any} */ p) => p.text).join(' ').includes('GEMINI QUESTION'), 'question kept');
});

test('W6/inbox-tool-pair: a trailing tool_result keeps its pair', async () => {
    const { interleavePendingRows } = await import('../lib/agentic/pending-inbox.mjs');
    const rows = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ];
    const out = interleavePendingRows({ rows, pending: [{ role: 'assistant', content: 'N' }] });
    const idxTool = out.findIndex((/** @type {any} */ r) => JSON.stringify(r).includes('tool_use'));
    const idxResult = out.findIndex((/** @type {any} */ r) => JSON.stringify(r).includes('tool_result'));
    assert.equal(idxResult, idxTool + 1, 'tool_use and tool_result stay adjacent');
    assert.equal(String(/** @type {any} */ (out.at(-1)).content), 'N', 'the notification is appended, not wedged in');
});

test('W6/inbox-claim-restore: a failed step puts the claimed row back', async () => {
    const { ChatSession } = await import('../lib/backends/oai.mjs');
    const client = makeClient();
    const session = new ChatSession({ client, model: 'm', eventEmitter: client });
    /** @type {any} */ (session)._runOnce = async () => { throw new Error('step turn failed'); };
    /** @type {any} */ (session)._pendingInputRows = [{ role: 'assistant', content: 'KEEP ME' }];
    const { runStep } = await import('../lib/agentic/step.mjs');
    await assert.rejects(() => runStep({ step: { name: 'p', model: 'm' }, deps: {
        session,
        messages: [createUserMessage({ provider: 'openai', content: 'question' })],
        maxIterations: 1,
        configureSession: false,
    } }), /step turn failed/);
    const kept = /** @type {any[]} */ (/** @type {any} */ (session)._pendingInputRows ?? []);
    assert.equal(kept.length, 1, 'the claim is restored');
    assert.equal(String(kept[0].content), 'KEEP ME');
});

test('W6/inbox-textless: a queued row with no text still delivers a marker (never dropped)', async () => {
    const { interleavePendingRows } = await import('../lib/agentic/pending-inbox.mjs');
    const rows = interleavePendingRows({
        rows: [{ role: 'user', content: 'question' }],
        pending: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] }],
    });
    assert.equal(rows.length, 1, 'folded');
    assert.ok(String(rows[0].content).includes('[background delegation update]'), 'a marker is delivered');
    assert.ok(String(rows[0].content).includes('question'), 'the prompt survives');
});
