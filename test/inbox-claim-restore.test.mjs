// @ts-check

/**
 * Characterization baseline for the inbox claim/restore protocol.
 *
 * Three paths take rows out of `session._pendingInputRows`, and they do NOT do
 * it at the same moment:
 *
 * 1. `runStep` (step.mjs) CLAIMS before `session.run`, because `session.run`
 *    drains the same inbox and would interleave the rows a second time. A
 *    failed turn puts them back at the FRONT, so nothing is lost.
 * 2. `ChatSessionBuilder.run` CLEARS only after `_runOnce` resolves, so a thrown
 *    run leaves the queued rows in place.
 * 3. `runAgenticLoop` CLAIMS `delivery: 'steer'` rows at each step boundary,
 *    `delivery: 'steer' | 'queue'` rows at a turn boundary, and restores the
 *    unacknowledged ones when the turn rejects. A row with no `delivery` (a
 *    background delegation result) is only drained at the start of a turn.
 *
 * Every claim is by object identity (`includes`), never by value: a structurally
 * equal clone must stay in the inbox.
 *
 * These tests pass against the pre-refactor code and are the differential
 * reference for the extraction into `pending-inbox.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runStep } from '../lib/agentic/step.mjs';
import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { claimSteerRows, claimTurnRows } from '../lib/agentic/pending-inbox.mjs';
import { getSpawnRegistry } from '../lib/agentic/spawn-registry.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';

/** @param {string} text @returns {any} */
const userRow = (text) => createUserMessage({ provider: 'openai', content: text });

/** @param {string} text @returns {any} a row the loop claims at a step boundary */
const steerRow = (text) => ({ ...userRow(text), delivery: 'steer' });

/** @param {string} text @returns {any} a row that waits for the turn boundary */
const queueRow = (text) => ({ ...userRow(text), delivery: 'queue' });

/**
 * Everything the model would read, as one string.
 * @param {any} input a prompt string or a message row list
 * @returns {string}
 */
function textOfInput(input) {
    if (typeof input === 'string') return input;
    const rows = Array.isArray(input) ? input : [input];
    return rows
        .map((/** @type {any} */ row) => (typeof row?.content === 'string' ? row.content : JSON.stringify(row?.content ?? '')))
        .join('\n');
}

/** @param {{input: any}} arg0 @returns {string[]} */
const rowTexts = ({ input }) => (Array.isArray(input) ? input : [input])
    .map((/** @type {any} */ row) => String(row?.content ?? ''));

/** @param {string} haystack @param {string} needle @returns {number} */
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

/**
 * A session-shaped object `runStep` can drive without building a backend: the
 * only method it needs is `run`, and `configureSession: false` keeps every
 * builder call off the object.
 * @param {{onRun?: ((arg0: {session: any, initialInput: any}) => Promise<void>|void)|null}} [arg0]
 * @returns {{session: any, atRun: () => {input: any, inbox: any}|null}}
 */
function stepHarness({ onRun = null } = {}) {
    /** @type {{input: any, inbox: any}|null} */
    let atRun = null;
    const session = /** @type {any} */ ({
        provider: 'openai',
        model: 'inbox-model',
        /** @type {Array<any>|undefined} */
        _pendingInputRows: undefined,
        /** @param {{initialInput: any}} arg0 */
        run: async ({ initialInput }) => {
            // Snapshot what the inbox looks like at the moment the turn starts.
            atRun = { input: initialInput, inbox: session._pendingInputRows };
            if (typeof onRun === 'function') await onRun({ session, initialInput });
            return 'answer';
        },
    });
    return { session, atRun: () => atRun };
}

/**
 * A builder whose `_runOnce` is replaced, so `run()`'s inbox handling is
 * observed without a backend.
 * @param {{onRun?: ((arg0: {initialInput: any}) => Promise<string>|string)|null}} [arg0]
 * @returns {{session: any, runs: Array<any>}}
 */
function builderHarness({ onRun = null } = {}) {
    const session = /** @type {any} */ (new ChatSessionBuilder());
    session.provider = 'openai';
    /** @type {Array<any>} */
    const runs = [];
    session._runOnce = async (/** @type {{initialInput: any}} */ { initialInput }) => {
        runs.push(initialInput);
        return typeof onRun === 'function' ? await onRun({ initialInput }) : 'answer';
    };
    return { session, runs };
}

/**
 * One scripted model call per step, driven through the real loop.
 * @param {{steps: Array<(arg0: {messages: Array<any>}) => Promise<{content: string}>|{content: string}>}} arg0
 * @returns {{session: any, seen: Array<Array<any>>}}
 */
function scriptedSession({ steps }) {
    /** @type {Array<Array<any>>} */
    const seen = [];
    const session = /** @type {any} */ ({
        provider: 'openai',
        model: 'steer-model',
        client: {},
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
    });
    return { session, seen };
}

// ---------------------------------------------------------------------------
// 1. claim-before: runStep takes the rows before session.run sees the inbox
// ---------------------------------------------------------------------------

test('runStep claims the inbox BEFORE session.run, and delivers each row once', async () => {
    const rowA = userRow('alpha');
    const rowB = userRow('beta');
    const { session, atRun } = stepHarness();
    session._pendingInputRows = [rowA, rowB];

    const out = await runStep({ deps: { session, userText: 'go', configureSession: false } });

    assert.equal(out.result, 'answer');
    const captured = atRun();
    assert.deepEqual(captured?.inbox, [], 'the rows were claimed before the turn started (claim-before, not clear-after)');
    const text = textOfInput(captured?.input);
    assert.equal(countOf(text, 'alpha'), 1, 'rowA was delivered exactly once');
    assert.equal(countOf(text, 'beta'), 1, 'rowB was delivered exactly once');
    assert.deepEqual(session._pendingInputRows, [], 'a successful step leaves the inbox empty');
});

test('runStep does not clear a row that lands DURING the turn', async () => {
    const rowA = userRow('alpha');
    /** @type {any} */
    let landed = null;
    const { session, atRun } = stepHarness({
        onRun: ({ session: live }) => {
            landed = userRow('landed-during-run');
            live._pendingInputRows = [...(live._pendingInputRows ?? []), landed];
        },
    });
    session._pendingInputRows = [rowA];

    await runStep({ deps: { session, userText: 'go', configureSession: false } });

    assert.ok(landed);
    assert.equal(atRun()?.inbox?.length, 0, 'the claimed row was already gone at turn start');
    assert.deepEqual(session._pendingInputRows, [landed], 'only the claimed rows were claimed; the new one waits');
    assert.equal(countOf(textOfInput(atRun()?.input), 'landed-during-run'), 0, 'it was not delivered by this turn');
});

test('runStep restores the claimed rows at the FRONT when the turn throws', async () => {
    const rowA = userRow('alpha');
    const rowB = userRow('beta');
    const rowC = userRow('gamma');
    const { session } = stepHarness({
        onRun: ({ session: live }) => {
            // Lands while the turn is in flight, then the turn fails.
            live._pendingInputRows = [...(live._pendingInputRows ?? []), rowC];
            throw new Error('step failed');
        },
    });
    session._pendingInputRows = [rowA, rowB];

    await assert.rejects(
        () => runStep({ deps: { session, userText: 'go', configureSession: false } }),
        /step failed/,
    );

    assert.equal(session._pendingInputRows.length, 3, 'nothing was lost');
    assert.equal(session._pendingInputRows[0], rowA, 'restored rows precede rows that landed during the turn');
    assert.equal(session._pendingInputRows[1], rowB);
    assert.equal(session._pendingInputRows[2], rowC);
});

// ---------------------------------------------------------------------------
// 2./3. clear-after: ChatSessionBuilder.run clears only when the run succeeds
// ---------------------------------------------------------------------------

test('run() delivers queued rows exactly once and clears them only on success', async () => {
    const rowA = userRow('alpha');
    const { session, runs } = builderHarness();
    session._pendingInputRows = [rowA];

    assert.equal(await session.run({ initialInput: 'go' }), 'answer');
    assert.equal(countOf(textOfInput(runs[0]), 'alpha'), 1, 'delivered exactly once');
    assert.deepEqual(session._pendingInputRows, [], 'cleared after the successful run');

    assert.equal(await session.run({ initialInput: 'again' }), 'answer');
    assert.equal(countOf(textOfInput(runs[1]), 'alpha'), 0, 'a second run does not deliver the same row again');
});

test('run() leaves the queued row in the inbox when the run throws', async () => {
    const rowA = userRow('alpha');
    const { session, runs } = builderHarness({
        onRun: () => { throw new Error('run failed'); },
    });
    session._pendingInputRows = [rowA];

    await assert.rejects(() => session.run({ initialInput: 'go' }), /run failed/);

    assert.equal(runs.length, 1, 'the row did reach the attempted turn');
    assert.deepEqual(session._pendingInputRows, [rowA], 'a failed run keeps it for the next attempt');
    assert.equal(session._pendingInputRows[0], rowA, 'the same object, not a copy');
});

test('run() clears by identity: a structurally equal row that landed during the run survives', async () => {
    const rowA = userRow('alpha');
    /** @type {any} */
    let clone = null;
    const { session, runs } = builderHarness({
        onRun: ({ initialInput }) => {
            assert.equal(countOf(textOfInput(initialInput), 'alpha'), 1, 'the queued row was delivered');
            // Same content, different object: only `includes` may spare it.
            clone = { ...rowA };
            session._pendingInputRows = [...(session._pendingInputRows ?? []), clone];
            return 'answer';
        },
    });
    session._pendingInputRows = [rowA];

    await session.run({ initialInput: 'go' });

    assert.ok(clone);
    assert.equal(runs.length, 1);
    assert.deepEqual(session._pendingInputRows, [clone], 'the claimed row was removed by identity, the equal newcomer was not');
    assert.equal(session._pendingInputRows[0], clone);
});

test('a streamed run drains the inbox into its next chunk, not into a later run', async () => {
    /** @type {{session: any, runs: Array<any>}} */
    let harness = /** @type {any} */ (null);
    harness = builderHarness({ onRun: async () => {
        // The user sends while the first chunk's turn is working.
        if (harness.runs.length === 1) harness.session._pendingInputRows = [queueRow('sent during chunk one')];
        return 'answer';
    }});

    async function* chunks() { yield 'one'; yield 'two'; }

    assert.equal(await harness.session.run({ initialInput: chunks() }), 'answer');
    assert.equal(harness.runs.length, 2, 'one turn per chunk');
    assert.equal(countOf(textOfInput(harness.runs[1]), 'sent during chunk one'), 1, 'the next chunk carried it');
    assert.equal(harness.session._pendingInputRows?.length ?? 0, 0, 'claimed, not left for a run that may never come');
});

test('a message that lands after the last chunk still gets a turn before run() resolves', async () => {
    /** @type {{session: any, runs: Array<any>}} */
    let harness = /** @type {any} */ (null);
    harness = builderHarness({ onRun: async () => {
        if (harness.runs.length === 1) harness.session._pendingInputRows = [steerRow('after the last chunk')];
        return 'answer';
    }});

    async function* chunks() { yield 'only'; }

    assert.equal(await harness.session.run({ initialInput: chunks() }), 'answer');
    assert.equal(harness.runs.length, 2, 'the tail turn ran');
    assert.equal(countOf(textOfInput(harness.runs[1]), 'after the last chunk'), 1);
    assert.equal(harness.session._pendingInputRows?.length ?? 0, 0, 'nothing is left pending');
});

test('a message that lands after the run\'s last turn boundary is still answered by that run', async () => {
    /** @type {{session: any, runs: Array<any>}} */
    let harness = /** @type {any} */ (null);
    harness = builderHarness({ onRun: async () => {
        // The output-guardrail / checkpoint window: the turn already produced its
        // answer, the promise has not resolved yet.
        if (harness.runs.length === 1) harness.session._pendingInputRows = [queueRow('slipped in')];
        return 'answer';
    }});

    assert.equal(await harness.session.run({ initialInput: 'start' }), 'answer');
    assert.equal(harness.runs.length, 2, 'the run answered it before resolving');
    assert.equal(countOf(textOfInput(harness.runs[1]), 'slipped in'), 1);
});

test('a failed continuation puts the message that triggered it back on the inbox', async () => {
    /** @type {{session: any, runs: Array<any>}} */
    let harness = /** @type {any} */ (null);
    harness = builderHarness({ onRun: async () => {
        if (harness.runs.length === 1) harness.session._pendingInputRows = [queueRow('retry me')];
        else throw new Error('continuation failed');
        return 'first answer';
    }});

    await assert.rejects(() => harness.session.run({ initialInput: 'start' }), /continuation failed/);
    assert.equal(harness.runs.length, 2, 'the run did try the continuation');
    assert.equal(harness.session._pendingInputRows?.length, 1, 'the message was not swallowed by the failed turn');
    assert.equal(harness.session._pendingInputRows[0].content, 'retry me', 'the same row');
});

test('maxInboxTurns bounds the inbox-driven turns and leaves the rest pending', async () => {
    /** @type {{session: any, runs: Array<any>}} */
    let harness = /** @type {any} */ (null);
    harness = builderHarness({ onRun: async () => {
        // A host that enqueues on every turn: without a cap this run never ends.
        harness.session._pendingInputRows = [...(harness.session._pendingInputRows ?? []), queueRow(`queued ${harness.runs.length}`)];
        return 'answer';
    }});
    harness.session.eventEmitter = new EventEmitter();
    /** @type {Array<any>} */
    const events = [];
    harness.session.eventEmitter.on(EVENTS.CLIENT.WARNING, (/** @type {any} */ e) => events.push(e));

    assert.equal(await harness.session.run({ initialInput: 'start', options: { maxInboxTurns: 2 } }), 'answer');
    assert.equal(harness.runs.length, 3, 'the opening turn plus the two the cap allows');
    assert.equal(harness.session._pendingInputRows.length, 1, 'the third message waits, it is not dropped');
    const warning = events.find((e) => e.code === 'INBOX_TURNS_EXHAUSTED');
    assert.ok(warning, 'the spent budget is announced');
    assert.match(String(warning?.message), /1 submitted message/);
    assert.equal(events.filter((e) => e.code === 'INBOX_TURNS_EXHAUSTED').length, 1, 'once, not once per layer');
});

test('the spent inbox-turn budget is announced once even when the loop hits the cap first', async () => {
    const session = /** @type {any} */ (new ChatSessionBuilder());
    session.provider = 'openai';
    session.model = 'inbox-model';
    session.client = {};
    session.eventEmitter = new EventEmitter();
    /** @type {Array<any>} */
    const warnings = [];
    session.eventEmitter.on(EVENTS.CLIENT.WARNING, (/** @type {any} */ e) => {
        if (e?.code === 'INBOX_TURNS_EXHAUSTED') warnings.push(e);
    });
    let turns = 0;
    /** @param {{messages: Array<any>}} arg0 */
    session.step = async function* step({ messages }) {
        turns += 1;
        const queued = /** @type {any} */ (createUserMessage({ provider: 'openai', content: `queued ${turns}` }));
        queued.delivery = 'queue';
        session._pendingInputRows = [...(session._pendingInputRows ?? []), queued];
        return { done: true, content: `answer ${turns}`, messages: [...messages, { role: 'assistant', content: 'x' }] };
    };

    const result = await session.run({ initialInput: 'start', options: { maxInboxTurns: 1, maxIterations: 2 } });

    assert.equal(result, 'answer 2', 'the run returns the answer it has');
    assert.equal(turns, 2, 'the opening turn plus the one the cap allows');
    assert.equal(warnings.length, 1, 'the loop and run() share one budget, so one notice');
    assert.equal((session._pendingInputRows ?? []).length, 1, 'the rest stays pending');
});

test('a steer that was already pending before run() is delivered exactly once', async () => {    const session = /** @type {any} */ (new ChatSessionBuilder());
    session.provider = 'openai';
    session.model = 'inbox-model';
    session.client = {};
    /** @type {Array<string>} */
    const seen = [];
    /** @param {{messages: Array<any>}} arg0 */
    session.step = async function* step({ messages }) {
        seen.push(textOfInput(messages));
        return { done: true, content: 'answer', messages: [...messages, { role: 'assistant', content: 'answer' }] };
    };
    session._pendingInputRows = [steerRow('PRE-STEER')];

    assert.equal(await session.run({ initialInput: 'start', options: { maxIterations: 2 } }), 'answer');
    assert.equal(seen.length, 1, 'one turn');
    assert.equal(countOf(seen[0], 'PRE-STEER'), 1, 'run() and the loop do not both deliver it');
});
// ---------------------------------------------------------------------------
// 4. steer claim: agentic-core claims 'steer' rows at a step boundary
// ---------------------------------------------------------------------------

test('a steer is claimed at a step boundary and does not survive into the next turn', async () => {
    /** @type {any} */
    let steer = null;
    const { session, seen } = scriptedSession({
        steps: [
            async () => {
                steer = steerRow('also check the logs');
                session._pendingInputRows = [steer];
                return { content: 'first answer' };
            },
            async () => ({ content: 'second answer' }),
        ],
    });

    const result = await runAgenticLoop({ session, messages: [userRow('start')] });

    assert.equal(result, 'second answer');
    assert.equal(seen.length, 2, 'the steer started another turn');
    assert.equal(countOf(textOfInput(seen[1]), 'also check the logs'), 1, 'delivered exactly once');
    assert.deepEqual(session._pendingInputRows, [], 'a claimed steer is not left for the next turn');
});

test('a queue row does not join the running step, but starts the next turn of the same run', async () => {
    const { session, seen } = scriptedSession({
        steps: [
            async () => {
                session._pendingInputRows = [queueRow('wait for me')];
                return { content: 'interim answer' };
            },
            async () => ({ content: 'answer to the queued message' }),
        ],
    });

    const result = await runAgenticLoop({ session, messages: [userRow('start')] });

    assert.equal(result, 'answer to the queued message');
    assert.equal(seen.length, 2, 'a turn of its own, inside the same run');
    assert.equal(countOf(textOfInput(seen[1]), 'wait for me'), 1, 'the turn after the answer carries it, exactly once');
    assert.equal((session._pendingInputRows ?? []).length, 0, 'nothing is left for a run that may never happen');
});

test('the two claims split the inbox: steers at a step, steers+queues at a turn', () => {
    /** @type {any} */
    const steer = steerRow('steer me');
    /** @type {any} */
    const queued = queueRow('queue me');
    /** @type {any} */
    const background = { role: 'assistant', content: '[Subagent "scout" finished]' };
    /** @type {any} */
    const session = { _pendingInputRows: [steer, queued, background] };

    assert.deepEqual(claimSteerRows({ session }), [steer], 'a step boundary takes steers only');
    assert.deepEqual(session._pendingInputRows, [queued, background], 'the queue row is still waiting');
    assert.deepEqual(claimTurnRows({ session }), [queued], 'a turn boundary takes the queue row');
    assert.deepEqual(session._pendingInputRows, [background], 'a background result is not an instruction');
});

test('a failed turn restores its claimed steers at the FRONT of the inbox', async () => {
    /** @type {any} */
    let first = null;
    /** @type {any} */
    let second = null;
    const { session, seen } = scriptedSession({
        steps: [
            async () => {
                first = steerRow('first steer');
                session._pendingInputRows = [first];
                return { content: 'first answer' };
            },
            async () => {
                // Lands during the failing turn: the restore must put `first` ahead of it.
                second = steerRow('second steer');
                session._pendingInputRows = [...(session._pendingInputRows ?? []), second];
                throw new Error('turn failed');
            },
        ],
    });

    await assert.rejects(
        () => runAgenticLoop({ session, messages: [userRow('start')] }),
        /turn failed/,
    );

    assert.equal(seen.length, 2, 'the first steer did reach a turn');
    assert.deepEqual(session._pendingInputRows, [first, second], 'restored rows precede rows that landed during the turn');
    assert.equal(session._pendingInputRows[0], first);
    assert.equal(session._pendingInputRows[1], second);
});

test('a steer claim is by identity: an equal row not submitted for this run stays queued', async () => {
    /** @type {any} */
    let steer = null;
    /** @type {any} */
    let shadow = null;
    const { session, seen } = scriptedSession({
        steps: [
            async () => {
                steer = steerRow('shared text');
                // Same text, no delivery: a background result, not a submission.
                shadow = { ...steer, delivery: undefined };
                session._pendingInputRows = [steer, shadow];
                return { content: 'first answer' };
            },
            async () => ({ content: 'second answer' }),
        ],
    });

    await runAgenticLoop({ session, messages: [userRow('start')] });

    assert.equal(seen.length, 2);
    assert.equal(countOf(textOfInput(seen[1]), 'shared text'), 1, 'only the steer row was injected');
    assert.deepEqual(session._pendingInputRows, [shadow], 'the stranded row was not removed by value equality');
    assert.equal(session._pendingInputRows[0], shadow);
});

test('an empty inbox is not rewritten while a turn runs', async () => {
    const { session, seen } = scriptedSession({
        steps: [
            async () => {
                assert.equal(session._pendingInputRows, undefined, 'no claim created the field');
                return { content: 'only answer' };
            },
        ],
    });

    await runAgenticLoop({ session, messages: [userRow('start')] });

    assert.equal(seen.length, 1);
    assert.equal(session._pendingInputRows, undefined, 'the field stays undefined when nothing was claimed');
});

// ---------------------------------------------------------------------------
// 5. drainInbox: the idle dispatcher, and the inbox lifecycle events
// ---------------------------------------------------------------------------

/** @returns {{session: any, runs: Array<any>}} a builder whose engine call is replaced */
function drainHarness() {
    const session = /** @type {any} */ (new ChatSessionBuilder());
    session.provider = 'openai';
    session.eventEmitter = new EventEmitter();
    /** @type {Array<any>} */
    const runs = [];
    session._runOnce = async (/** @type {{initialInput: any}} */ { initialInput }) => {
        runs.push(initialInput);
        return `answer ${runs.length}`;
    };
    return { session, runs };
}

test('drainInbox answers the queue one message per turn and labels each answer', async () => {
    const { session, runs } = drainHarness();
    /** @type {any} */
    const first = queueRow('one');
    /** @type {any} */
    const second = queueRow('two');
    /** @type {any} */
    const ride = steerRow('ride along');
    session._pendingInputRows = [first, second, ride];

    const drained = await session.drainInbox();

    assert.equal(runs.length, 2, 'the steer rides the first queued turn; each queued message gets its own');
    assert.equal(countOf(textOfInput(runs[0]), 'ride along'), 1);
    assert.equal(countOf(textOfInput(runs[0]), 'one'), 1);
    assert.equal(countOf(textOfInput(runs[0]), 'two'), 0, 'the second queued message waits for turn two');
    assert.equal(countOf(textOfInput(runs[1]), 'two'), 1);
    assert.deepEqual(drained?.answers.map((/** @type {any} */ entry) => entry.inboxId), [first.merciId, second.merciId], 'one answer per queued message');
    assert.deepEqual(drained?.answers.map((/** @type {any} */ entry) => entry.text), ['answer 1', 'answer 2']);
    assert.equal(drained?.text, 'answer 2', 'the last answer is the deliverable');
    assert.equal(session.getPendingInputs().length, 0, 'nothing is left');
});

test('drainInbox is a no-op when the inbox is empty', async () => {
    const { session, runs } = drainHarness();
    assert.equal(await session.drainInbox(), null, 'no model call, no invented prompt');
    assert.equal(runs.length, 0);
});

test('drainInbox refuses while a run is in flight', async () => {
    const { session } = drainHarness();
    session._pendingInputRows = [queueRow('wait')];
    session._runInFlight = true;
    await assert.rejects(() => session.drainInbox(), /in flight/);
    assert.equal(session.getPendingInputs().length, 1, 'the message is untouched');
});

test('drainInbox delivers a waiting background result too, and answers it', async () => {
    const { session, runs } = drainHarness();
    /** @type {any} */
    const background = { role: 'assistant', content: '[Subagent "scout" finished] found it' };
    session._pendingInputRows = [background];

    const drained = await session.drainInbox();

    assert.equal(runs.length, 1, 'the drain IS the next turn SP3 promises');
    assert.equal(countOf(textOfInput(runs[0]), 'found it'), 1);
    assert.equal(/** @type {any} */ (runs[0][0]).role, 'user', 'a request must not start with an assistant row');
    assert.equal(drained?.answers.length, 1);
    assert.equal(session.getPendingInputs().length, 0);
});

test('the inbox lifecycle is observable: enqueued, delivered, cancelled, delivery changed', async () => {
    const { session } = drainHarness();
    /** @type {Array<{name: string, payload: any}>} */
    const seen = [];
    for (const name of [
        EVENTS.SESSION.INPUT_ENQUEUED,
        EVENTS.SESSION.INPUT_DELIVERED,
        EVENTS.SESSION.INPUT_CANCELLED,
        EVENTS.SESSION.INPUT_DELIVERY_CHANGED,
    ]) {
        session.eventEmitter.on(name, (/** @type {any} */ e) => seen.push({ name, payload: e }));
    }

    /** @type {any} */
    const keep = session.enqueueInput({ input: 'keep me' });
    /** @type {any} */
    const withdrawn = session.enqueueInput({ input: 'withdraw me', delivery: 'queue' });
    session.setInputDelivery({ input: withdrawn, delivery: 'steer' });
    session.cancelInput({ input: withdrawn });
    await session.drainInbox();

    const names = seen.map((entry) => entry.name);
    assert.ok(names.includes(EVENTS.SESSION.INPUT_ENQUEUED), 'enqueue announced');
    assert.ok(names.includes(EVENTS.SESSION.INPUT_DELIVERY_CHANGED), 'the toggle announced');
    assert.ok(names.includes(EVENTS.SESSION.INPUT_CANCELLED), 'the withdrawal announced');
    assert.ok(names.includes(EVENTS.SESSION.INPUT_DELIVERED), 'the delivery announced');
    const delivered = seen.find((entry) => entry.name === EVENTS.SESSION.INPUT_DELIVERED);
    assert.equal(delivered?.payload?.inboxId, keep.merciId, 'the delivered event names the message');
    assert.equal(delivered?.payload?.delivery, 'steer');
    const cancelled = seen.find((entry) => entry.name === EVENTS.SESSION.INPUT_CANCELLED);
    assert.equal(cancelled?.payload?.inboxId, withdrawn.merciId);
});

// ---------------------------------------------------------------------------
// 6. the background gate: a queued message waits for the spawn tree
// ---------------------------------------------------------------------------

/**
 * A harness whose client carries a spawn registry, so the drain's subagent gate
 * can be driven without a backend.
 * @returns {{session: any, runs: Array<any>, registry: any}}
 */
function backgroundHarness() {
    const { session, runs } = drainHarness();
    session.client = {};
    const registry = getSpawnRegistry({ client: session.client });
    return { session, runs, registry };
}

/** @param {{registry: any, session: any, taskId?: string}} arg0 */
function startFakeBackground({ registry, session, taskId = 'task_1' }) {
    registry.background.set(taskId, new Promise(() => {}));
    registry.spawns.set(`spawn_${taskId}`, { taskId, parent: session });
}

test('drainInbox waits for a live background subagent and reports the skip', async () => {
    const { session, runs, registry } = backgroundHarness();
    session._pendingInputRows = [queueRow('after the subagent')];
    startFakeBackground({ registry, session });

    assert.equal(session.hasLiveBackgroundWork(), true, 'the session owns a live background task');
    const skipped = await session.drainInbox({ options: { backgroundTimeoutMs: 0 } });
    assert.equal(skipped?.skipped, 'background');
    assert.deepEqual(skipped?.answers, []);
    assert.equal(runs.length, 0, 'no turn is answered into a working tree');
    assert.equal(session.getPendingInputs().length, 1, 'the queue is untouched');

    registry.background.delete('task_1');
    assert.equal(session.hasLiveBackgroundWork(), false);
    const drained = await session.drainInbox();
    assert.equal(drained?.answers.length, 1, 'it drains once the tree is idle');
});

test('waitForBackgroundWork polls until the subagent settles', async () => {
    const { session, registry } = backgroundHarness();
    startFakeBackground({ registry, session });
    setTimeout(() => registry.background.delete('task_1'), 20);

    assert.equal(await session.waitForBackgroundWork({ timeoutMs: 500, recheckMs: 5 }), true, 'the gate opens on its own');
    assert.equal(session.hasLiveBackgroundWork(), false);
});

test('waitForBackgroundWork returns false at the deadline', async () => {
    const { session, registry } = backgroundHarness();
    startFakeBackground({ registry, session });
    assert.equal(await session.waitForBackgroundWork({ timeoutMs: 20, recheckMs: 5 }), false);
});

test('a background task of ANOTHER session does not block this one', async () => {
    const { session, registry } = backgroundHarness();
    const other = /** @type {any} */ ({ sessionId: 'other-session' });
    registry.background.set('task_9', new Promise(() => {}));
    registry.spawns.set('spawn_9', { taskId: 'task_9', parent: other });

    assert.equal(session.hasLiveBackgroundWork(), false);
    session._pendingInputRows = [queueRow('mine')];
    const drained = await session.drainInbox({ options: { backgroundTimeoutMs: 0 } });
    assert.equal(drained?.answers.length, 1);
});

test('a subagent that starts mid-drain stops the next turn and keeps the rest', async () => {
    /** @type {{session: any, runs: Array<any>, registry: any}} */
    let harness = /** @type {any} */ (null);
    harness = backgroundHarness();
    harness.session._runOnce = async (/** @type {{initialInput: any}} */ { initialInput }) => {
        harness.runs.push(initialInput);
        // The first answered turn starts a delegation; the next iteration must see it.
        startFakeBackground({ registry: harness.registry, session: harness.session });
        return `answer ${harness.runs.length}`;
    };
    harness.session._pendingInputRows = [queueRow('first'), queueRow('second')];

    const drained = await harness.session.drainInbox({ options: { backgroundTimeoutMs: 0 } });

    assert.equal(harness.runs.length, 1, 'exactly one turn ran');
    assert.equal(drained?.answers.length, 1);
    assert.equal(drained?.skipped, 'background', 'the rest waits for the tree');
    assert.equal(harness.session.getPendingInputs().length, 1, 'the second message is still queued');
});

test('an empty queue returns null even while a subagent runs', async () => {
    const { session, registry } = backgroundHarness();
    startFakeBackground({ registry, session });
    assert.equal(await session.drainInbox(), null);
});
