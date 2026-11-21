// @ts-check

/**
 * SP7 — steering a running turn.
 *
 * A host can hand the session a message while a turn is in flight
 * (`session.enqueueInput`). A `steer` row reaches the model at the next step
 * boundary of that run; a `queue` row keeps the historical behaviour and waits
 * for the next turn (background delegation results are queued).
 *
 * The oracle is the engine: a real `runAgenticLoop` on a scripted `step`, so the
 * placement, the continuation and the at-least-once restore are observed on the
 * requests the model actually receives.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { interleavePendingRows } from '../lib/agentic/pending-inbox.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

/**
 * One scripted model call.
 * @typedef {(arg0: {messages: Array<any>}) => Promise<{content: string}>} StepScript
 */

/**
 * A session-like that drives the real loop with a scripted model call, one
 * script entry per step.
 * @param {{steps: Array<StepScript>}} arg0
 * @returns {{session: any, seen: Array<Array<any>>}}
 */
function scriptedSession({ steps }) {
    /** @type {Array<Array<any>>} */
    const seen = [];
    const session = {
        provider: 'openai',
        model: 'steer-model',
        client: /** @type {any} */ ({}),
        eventEmitter: new EventEmitter(),
        /** @type {Array<Object>} */
        _tools: [],
        /** @type {Array<any>|undefined} */
        _pendingInputRows: undefined,
        withToolAllowlist() { return session; },
        withSystemMessage() { return session; },
        withTools() { return session; },
        /** @param {{messages: Array<any>}} arg0 */
        step: async function* step({ messages }) {
            seen.push([...messages]);
            const scripted = steps[seen.length - 1];
            const out = await scripted({ messages });
            return {
                done: true,
                content: out.content,
                messages: [...messages, { role: 'assistant', content: out.content }],
            };
        },
    };
    return { session, seen };
}

/** @param {string} text @returns {any} a row the loop will see */
function steerable(text) {
    const row = /** @type {any} */ (createUserMessage({ provider: 'openai', content: text }));
    row.delivery = 'steer';
    return row;
}

test('SP7: a steer sent mid-run reaches the model at the next step boundary', async () => {
    /** @type {any} */
    let steer = null;
    const { session, seen } = scriptedSession({
        steps: [
            async () => {
                // The host injects while the first step is still running.
                steer = steerable('also check the logs');
                session._pendingInputRows = [...(session._pendingInputRows ?? []), steer];
                return { content: 'first answer' };
            },
            async () => ({ content: 'second answer' }),
        ],
    });

    const result = await runAgenticLoop({
        session,
        messages: [createUserMessage({ provider: 'openai', content: 'start' })],
    });

    assert.equal(result, 'second answer', 'the steer produced a new answer in the same run');
    assert.equal(seen.length, 2, 'the final answer did not end the run: the steer started another turn');
    const secondTurn = seen[1].map((row) => String(row?.content ?? ''));
    assert.ok(secondTurn.some((text) => text.includes('also check the logs')), 'the steer rides the next request');
    assert.deepEqual(session._pendingInputRows ?? [], [], 'the steer was claimed, not delivered twice');
});

test('SP7: a steer that lands on the final answer continues the run instead of being dropped', async () => {
    const { session, seen } = scriptedSession({
        steps: [
            async ({ messages }) => {
                // Arrives after the model already produced its answer.
                session._pendingInputRows = [...(session._pendingInputRows ?? []), steerable('one more thing')];
                return { content: 'answer one' };
            },
            async () => ({ content: 'answer two' }),
        ],
    });

    const result = await runAgenticLoop({
        session,
        messages: [createUserMessage({ provider: 'openai', content: 'go' })],
    });

    assert.equal(result, 'answer two');
    assert.equal(seen.length, 2);
    const secondTurn = seen[1].map((row) => String(row?.content ?? ''));
    assert.ok(secondTurn.includes('answer one'), 'the model sees the answer it already gave');
    assert.ok(secondTurn.some((text) => text.includes('one more thing')), 'and the steer after it');
});

test('SP7: a turn that fails puts its claimed steer back (at-least-once)', async () => {
    /** @type {any} */
    let steer = null;
    const { session, seen } = scriptedSession({
        steps: [
            async () => {
                steer = steerable('keep me');
                session._pendingInputRows = [...(session._pendingInputRows ?? []), steer];
                return { content: 'first answer' };
            },
            async () => {
                throw new Error('model call failed');
            },
        ],
    });

    await assert.rejects(
        () => runAgenticLoop({ session, messages: [createUserMessage({ provider: 'openai', content: 'start' })] }),
        /model call failed/,
    );

    assert.equal(seen.length, 2, 'the steer was claimed before the failing turn');
    assert.deepEqual(session._pendingInputRows, [steer], 'the failed turn restores it for the next run');
});

test('SP7: a queue row does not interrupt the running step, but gets its own turn in the same run', async () => {
    const { session, seen } = scriptedSession({
        steps: [
            async () => {
                // The user sends this while the first step is running.
                const queued = /** @type {any} */ (createUserMessage({ provider: 'openai', content: 'later' }));
                queued.delivery = 'queue';
                session._pendingInputRows = [...(session._pendingInputRows ?? []), queued];
                return { content: 'interim answer' };
            },
            async () => ({ content: 'answer to the queued message' }),
        ],
    });

    const result = await runAgenticLoop({
        session,
        messages: [createUserMessage({ provider: 'openai', content: 'start' })],
    });

    assert.equal(result, 'answer to the queued message', 'the run answered it before returning');
    assert.equal(seen.length, 2, 'a queue row starts a turn of its own, inside the same run');
    assert.ok(seen[1].some((row) => String(row?.content ?? '').includes('later')), 'that turn carries it');
    assert.ok(seen[1].some((row) => String(row?.content ?? '').includes('interim answer')), 'and the answer it follows');
    assert.deepEqual(session._pendingInputRows ?? [], [], 'claimed — a one-shot caller never has to run again');
});

test('SP7: a background result (no delivery) still waits for the next run', async () => {
    const { session, seen } = scriptedSession({
        steps: [
            async () => {
                // A finished background delegation lands with no `delivery`.
                session._pendingInputRows = [...(session._pendingInputRows ?? []), {
                    role: 'assistant', content: '[Subagent "scout" finished] found it',
                }];
                return { content: 'only answer' };
            },
        ],
    });

    const result = await runAgenticLoop({
        session,
        messages: [createUserMessage({ provider: 'openai', content: 'start' })],
    });

    assert.equal(result, 'only answer');
    assert.equal(seen.length, 1, 'conversation state does not force a new turn');
    assert.equal((session._pendingInputRows ?? []).length, 1, 'the next turn delivers it (SP3)');
});

test('SP7: the inbox-turn cap stops a host that keeps enqueueing, and leaves the rest pending', async () => {
    const { session, seen } = scriptedSession({
        steps: [
            async () => {
                const first = /** @type {any} */ (createUserMessage({ provider: 'openai', content: 'first queued' }));
                first.delivery = 'queue';
                session._pendingInputRows = [...(session._pendingInputRows ?? []), first];
                return { content: 'a1' };
            },
            async () => {
                const second = /** @type {any} */ (createUserMessage({ provider: 'openai', content: 'second queued' }));
                second.delivery = 'queue';
                session._pendingInputRows = [...(session._pendingInputRows ?? []), second];
                return { content: 'a2' };
            },
        ],
    });
    /** @type {Array<any>} */
    const warnings = [];
    session.eventEmitter.on(EVENTS.CLIENT.WARNING, (/** @type {any} */ e) => warnings.push(e));

    const result = await runAgenticLoop({
        session,
        messages: [createUserMessage({ provider: 'openai', content: 'start' })],
        opts: { maxInboxTurns: 1 },
    });

    assert.equal(result, 'a2', 'the run returns the answer it has');
    assert.equal(seen.length, 2, 'exactly one inbox-driven turn was allowed');
    assert.equal((session._pendingInputRows ?? []).length, 1, 'the next message waits for the next run');
    assert.equal(/** @type {any} */ (session._pendingInputRows[0]).content, 'second queued', 'the row itself, not a copy');
    assert.ok(warnings.some((w) => w?.code === 'INBOX_TURNS_EXHAUSTED'), 'the spent budget is announced');
});

test('SP7: a steer claimed at a step boundary does not spend an inbox TURN', async () => {
    // A steer that rides a step inside a turn a followUp stage continues must not
    // cost a turn-budget unit: only a claim that STARTS another turn does.
    const { session, seen } = scriptedSession({
        steps: [
            async () => {
                session._pendingInputRows = [...(session._pendingInputRows ?? []), steerable('ride along')];
                return { content: 'draft' };
            },
            async () => {
                const queued = /** @type {any} */ (createUserMessage({ provider: 'openai', content: 'its own turn' }));
                queued.delivery = 'queue';
                session._pendingInputRows = [...(session._pendingInputRows ?? []), queued];
                return { content: 'a2' };
            },
            async () => ({ content: 'a3' }),
        ],
    });

    const result = await runAgenticLoop({
        session,
        messages: [createUserMessage({ provider: 'openai', content: 'start' })],
        opts: {
            maxInboxTurns: 1,
            // Round 0 returns a review stage; the steer then lands on the next
            // STEP of the same turn, not on a turn of its own.
            followUp: (/** @type {{round: number}} */ { round }) => (round === 0 ? 'review it' : null),
        },
    });

    assert.equal(result, 'a3', 'the queue row still got the one allowed turn');
    assert.equal(seen.length, 3, 'the followUp step, then the queued turn');
    assert.ok(seen[1].some((row) => String(row?.content ?? '').includes('ride along')), 'the steer joined the followUp step');
    assert.ok(seen[2].some((row) => String(row?.content ?? '').includes('its own turn')), 'the queue row started its own turn');
    assert.deepEqual(session._pendingInputRows ?? [], [], 'both were delivered inside the one run');
});


test('SP7: enqueueInput builds the row and defaults to steer', () => {
    const builder = new ChatSessionBuilder();
    builder.provider = 'openai';
    const inboxOf = () => /** @type {any} */ (builder)._pendingInputRows;

    const steer = /** @type {any} */ (builder.enqueueInput({ input: 'look into this' }));
    assert.ok(steer, 'a string becomes a row');
    assert.equal(steer.delivery, 'steer');
    assert.equal(steer.role, 'user');
    assert.equal(inboxOf().length, 1);

    const row = /** @type {any} */ (createUserMessage({ provider: 'openai', content: 'an existing row' }));
    const returned = builder.enqueueInput({ input: row, delivery: 'queue' });
    assert.equal(returned, row, 'an already-built row is kept as-is');
    assert.equal(row.delivery, 'queue');
    assert.equal(inboxOf().length, 2);

    assert.equal(builder.enqueueInput({ input: /** @type {any} */ (42) }), null, 'a non-row is refused');
    assert.equal(inboxOf().length, 2);
});

test('SP7: enqueueInput is idempotent for the same row, and refuses an unknown delivery', () => {
    const builder = new ChatSessionBuilder();
    builder.provider = 'openai';
    const inboxOf = () => /** @type {any} */ (builder)._pendingInputRows;

    const row = /** @type {any} */ (builder.enqueueInput({ input: 'deliver me once' }));
    builder.enqueueInput({ input: row });
    builder.enqueueInput({ input: row, delivery: 'queue' });
    assert.equal(inboxOf().length, 1, 'a retried enqueue does not duplicate the message');
    assert.equal(row.delivery, 'queue', 'the retry still sets the delivery it was asked for');
    assert.equal(inboxOf()[0], row, 'the same object, not a copy');

    assert.throws(
        () => builder.enqueueInput({ input: 'x', delivery: /** @type {any} */ ('later') }),
        /delivery must be 'steer' or 'queue'/,
        'a third mode is a host bug',
    );
    assert.equal(inboxOf().length, 1, 'a refused enqueue adds nothing');
});

test('SP7: getPendingInputs is a snapshot, cancelInput and setInputDelivery act on the live queue', () => {
    const builder = new ChatSessionBuilder();
    builder.provider = 'openai';
    /** @type {any} */
    const first = builder.enqueueInput({ input: 'first' });
    /** @type {any} */
    const second = builder.enqueueInput({ input: 'second', delivery: 'queue' });
    const inboxOf = () => /** @type {any} */ (builder)._pendingInputRows;

    const snapshot = builder.getPendingInputs();
    assert.deepEqual(snapshot.map((row) => /** @type {any} */ (row).content), ['first', 'second']);
    snapshot.length = 0;
    assert.equal(inboxOf().length, 2, 'emptying the snapshot does not empty the queue');
    snapshot.push(/** @type {any} */ ({ content: 'injected' }));
    assert.equal(inboxOf().length, 2, 'adding to the snapshot does not queue anything');

    assert.equal(builder.setInputDelivery({ input: second.merciId, delivery: 'steer' }), second, 'by merciId');
    assert.equal(second.delivery, 'steer');
    assert.throws(() => builder.setInputDelivery({ input: second, delivery: /** @type {any} */ ('now') }), /delivery/);

    assert.equal(builder.cancelInput({ input: first }), first, 'by row identity');
    assert.equal(builder.cancelInput({ input: first }), null, 'a second cancel finds nothing');
    assert.deepEqual(inboxOf(), [second]);

    builder.cancelInput({ input: second.merciId });
    assert.equal(builder.getPendingInputs().length, 0, 'cancelling by id empties the queue');
    assert.equal(builder.cancelInput({ input: second }), null, 'an id is not a row reference once removed');
});

test('SP7: a steer placed after an unanswered tool call closes the round first', () => {
    const history = [
        createUserMessage({ provider: 'openai', content: 'go' }),
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'lookup' }] },
    ];
    const steer = createUserMessage({ provider: 'openai', content: 'stop that' });

    const rows = interleavePendingRows({ rows: history, pending: [steer] });
    const at = rows.indexOf(steer);
    assert.ok(at > 0, 'the steer was placed');
    const before = rows.slice(0, at);
    const closesTheRound = before.some((row) =>
        row?.tool_call_id === 'call-1'
        || (Array.isArray(row?.content) && row.content.some((/** @type {any} */ block) => block?.tool_use_id === 'call-1')));
    assert.ok(closesTheRound, 'the dangling tool_use is closed before the steer can split the pair');
});

test('SP7: two queued messages become two turns, each in its own right', async () => {
    // OpenCode's `promote` rule: steers ride a turn together, but one queued
    // message per turn — the user sent two messages, so two answers come back.
    const { session, seen } = scriptedSession({
        steps: [
            async () => {
                for (const text of ['first queued', 'second queued']) {
                    const row = /** @type {any} */ (createUserMessage({ provider: 'openai', content: text }));
                    row.delivery = 'queue';
                    session._pendingInputRows = [...(session._pendingInputRows ?? []), row];
                }
                return { content: 'opening answer' };
            },
            async () => ({ content: 'answer to the first' }),
            async () => ({ content: 'answer to the second' }),
        ],
    });

    const result = await runAgenticLoop({
        session,
        messages: [createUserMessage({ provider: 'openai', content: 'start' })],
    });

    assert.equal(result, 'answer to the second', 'the last queued message answers last');
    assert.equal(seen.length, 3, 'opening turn plus one turn per queued message');
    assert.ok(seen[1].some((row) => String(row?.content ?? '').includes('first queued')));
    assert.ok(!seen[1].some((row) => String(row?.content ?? '').includes('second queued')), 'the second waits for turn two');
    assert.ok(seen[2].some((row) => String(row?.content ?? '').includes('second queued')));
    assert.deepEqual(session._pendingInputRows ?? [], [], 'both were delivered');
});
