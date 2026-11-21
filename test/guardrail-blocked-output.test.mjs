// @ts-check
/**
 * A blocked output must not be persisted. The old behaviour kept the whole
 * run's transcript, so a refused answer stayed in `_lastStepMessages` and in
 * every later checkpoint. Restoring the pre-run snapshot instead is also
 * wrong: it erases tool calls whose side effects already happened, and a
 * resumed session then disagrees with the journal. Keep the tool rows, drop
 * only the trailing assistant text the guard refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { InMemorySessionStore } from '../lib/agentic/sessions.mjs';
import { NoRetryPolicy } from '../lib/support/retry-policy.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';

/**
 * A session whose model calls `write_file` once, then answers with the tool
 * result it saw plus a secret the output guard refuses.
 * @param {{rules: any[]}} arg0
 */
function blockedSession({ rules }) {
    /** @type {any[]} */
    const executed = [];
    let call = 0;
    const session = /** @type {any} */ (new AbstractChatSession({ provider: ProviderType.OPENAI, model: 'm', eventEmitter: new EventEmitter(), client: /** @type {any} */ ({ session() {} }), retryPolicy: new NoRetryPolicy() }));
    session._streamTimeoutPolicy = {};
    session._adapter = {
        vendorName: 'FAKE',
        buildVendorRequest: (/** @type {any} */ { preparedMessages }) => ({ request: { preparedMessages }, observability: {} }),
        executeVendorRequest: async (/** @type {any} */ { request }) => {
            call += 1;
            const round = call;
            const lastTool = [...request.preparedMessages].reverse().find((/** @type {any} */ m) => m.role === 'tool');
            return (async function* () {
                if (round === 1) yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'write_file', args: { path: '/tmp/x', text: 'SIDE-EFFECT' } }] };
                else yield { type: 'text', content: `saw: ${String(lastTool?.content ?? '')} SECRET-ANSWER` };
            })();
        },
        consumeStream: (/** @type {any} */ { rawStream }) => rawStream,
        formatToolCall: (/** @type {any} */ { call: c }) => c,
    };
    session.withTools({ tools: [{ name: 'write_file', description: 'w', parameters: { type: 'object', properties: {} }, execute: async (/** @type {any} */ { args }) => { executed.push(args); return `wrote ${args.text}`; } }] });
    session.withGuardrails({ rules });
    return { session, executed };
}

/** @param {any[]} rows */
const rowsText = (rows) => rows.map((row) => JSON.stringify(row)).join('\n');

test('a blocked output is dropped from _lastStepMessages but the tool round survives', async () => {
    const { session, executed } = blockedSession({ rules: [{ name: 'no-secret', phase: 'output', pattern: 'SECRET-ANSWER' }] });
    await assert.rejects(runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] }), /Guardrail/);
    assert.equal(executed.length, 1, 'the tool ran before the answer was judged');

    const rows = session._lastStepMessages;
    assert.ok(Array.isArray(rows) && rows.length > 0, 'the run left a transcript');
    assert.doesNotMatch(rowsText(rows), /SECRET-ANSWER/, 'the refused answer is not persisted');
    assert.match(rowsText(rows), /SIDE-EFFECT/, 'the tool call row is kept');
    assert.ok(rows.some((/** @type {any} */ row) => row.role === 'tool' || row.type === 'tool_message'), 'the tool result row is kept');
});

test('a blocked output does not reach a checkpoint', async () => {
    const store = new InMemorySessionStore();
    const { session } = blockedSession({ rules: [{ name: 'no-secret', phase: 'output', pattern: 'SECRET-ANSWER' }] });
    session.withSessionStore({ store, threadId: 'blocked' });
    await assert.rejects(runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] }), /Guardrail/);
    await session.saveCheckpoint();

    const saved = await store.load('blocked');
    assert.ok(Array.isArray(saved?.messages) && saved.messages.length > 0);
    assert.doesNotMatch(rowsText(saved.messages), /SECRET-ANSWER/);
    assert.match(rowsText(saved.messages), /SIDE-EFFECT/, 'the checkpoint still matches the journal');
});

test('a blocked run with no tool rows restores the pre-run transcript', async () => {
    const session = /** @type {any} */ (new AbstractChatSession({ provider: ProviderType.OPENAI, model: 'm', eventEmitter: new EventEmitter(), client: /** @type {any} */ ({ session() {} }), retryPolicy: new NoRetryPolicy() }));
    session._streamTimeoutPolicy = {};
    session._adapter = {
        vendorName: 'FAKE',
        buildVendorRequest: (/** @type {any} */ { preparedMessages }) => ({ request: { preparedMessages }, observability: {} }),
        executeVendorRequest: async () => (async function* () { yield { type: 'text', content: 'SECRET-ANSWER' }; })(),
        consumeStream: (/** @type {any} */ { rawStream }) => rawStream,
        formatToolCall: (/** @type {any} */ { call: c }) => c,
    };
    const before = [{ role: 'assistant', content: 'the previous turn' }];
    session._lastStepMessages = before;
    session.withGuardrails({ rules: [{ name: 'no-secret', phase: 'output', pattern: 'SECRET-ANSWER' }] });

    await assert.rejects(runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] }), /Guardrail/);
    assert.deepEqual(session._lastStepMessages, before, 'a run with nothing worth keeping leaves the old transcript alone');
});

test('B-6: an interim assistant row carrying a blocked secret is refused, dropped, and never distilled', async () => {
    const { session, executed } = blockedSession({ rules: [{ name: 'no-secret', phase: 'output', pattern: 'SECRET-ANSWER' }] });
    let round = 0;
    session._adapter.executeVendorRequest = async () => {
        round += 1;
        return (async function* () {
            if (round === 1) {
                yield { type: 'text', content: 'Interim note: SECRET-ANSWER is 42. ' };
                yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'write_file', args: { path: '/tmp/x', text: 'SIDE-EFFECT' } }] };
            } else {
                yield { type: 'text', content: 'Final: SECRET-ANSWER' };
            }
        })();
    };
    /** @type {any[]} */
    const distilled = [];
    session._memoryManager = {
        shouldSync: () => true,
        /** @param {{messages: any[]}} arg0 */
        distill: async ({ messages }) => { distilled.push(messages); },
    };

    await assert.rejects(runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] }), /Guardrail/);

    assert.equal(executed.length, 1, 'the tool still ran');
    assert.deepEqual(distilled, [], 'a blocked answer must never reach memory distillation');
    const rows = rowsText(session._lastStepMessages ?? []);
    assert.doesNotMatch(rows, /Interim note/, 'the refused interim row is dropped, not kept beside the tool round');
    assert.doesNotMatch(rows, /SECRET-ANSWER/, 'no assistant row keeps the secret');
    assert.match(rows, /SIDE-EFFECT/, 'the tool row survives');
});

test('W2B-1: a blocked provider row keeps its tool_calls so the tool result is not orphaned', async () => {
    const { session, executed } = blockedSession({ rules: [{ name: 'no-secret', phase: 'output', pattern: 'SECRET-ANSWER' }] });
    let round = 0;
    session._adapter.executeVendorRequest = async () => {
        round += 1;
        return (async function* () {
            // One provider-shaped assistant turn: text AND tool_calls in one row.
            if (round === 1) {
                yield { type: 'text', content: 'Interim: SECRET-ANSWER is 42.' };
                yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'write_file', args: { path: '/tmp/x', text: 'SIDE-EFFECT' } }] };
            } else {
                yield { type: 'text', content: 'never reached' };
            }
        })();
    };

    await assert.rejects(runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] }), /Guardrail/);
    assert.equal(executed.length, 1, 'the tool ran before the answer was judged');

    /** @type {any[]} */
    const rows = session._lastStepMessages;
    assert.doesNotMatch(rowsText(rows), /SECRET-ANSWER/, 'the refused text is not persisted');
    const callRow = rows.find((row) => row.role === 'assistant' && Array.isArray(row.tool_calls));
    assert.ok(callRow, 'the assistant row that carried the calls is kept');
    assert.equal(callRow.content, '', 'only the refused text is stripped');
    const toolRow = rows.find((row) => row.role === 'tool');
    assert.ok(toolRow, 'the tool result row is kept');
    assert.equal(toolRow.tool_call_id, callRow.tool_calls[0].id, 'the tool result has a preceding call');
    assert.ok(rows.indexOf(callRow) < rows.indexOf(toolRow), 'the call row precedes its result');
});

test('W2B-5: one answer is judged once, not per row and again as the deliverable', async () => {
    let checks = 0;
    const { session } = blockedSession({ rules: [{
        name: 'warn-it',
        phase: 'output',
        action: 'warn',
        test: () => { checks += 1; return true; },
    }] });
    /** @type {any[]} */
    const trips = [];
    session.eventEmitter.on(EVENTS.GUARDRAIL.TRIPPED, (/** @type {any} */ e) => trips.push(e));
    session._adapter.executeVendorRequest = async () => (async function* () { yield { type: 'text', content: 'the answer' }; })();

    const out = await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] });

    assert.equal(out, 'the answer');
    assert.equal(checks, 1, 'the answer is checked once');
    assert.equal(trips.length, 1, 'one trip event per answer');
});
