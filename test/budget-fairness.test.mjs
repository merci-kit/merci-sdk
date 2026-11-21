// @ts-check
/**
 * B-3 fairness is admission control now, not a clamp.
 *
 * The reservation keeps the cap honest (a sibling cannot authorise the same
 * remainder twice), but it used to leave the second caller a 16-token allowance
 * and let it run — a 90-token answer came back as 16 characters with no
 * refusal. The loop now WAITS for an in-flight sibling's reservation to free a
 * usable share, and refuses the turn (`BudgetExceededError`) when the deadline
 * (`budget_admission_wait_ms`) passes without one. A turn only proceeds with an
 * allowance at or below `step_min_output_tokens` when it was never contended
 * (a lone caller whose pool is nearly spent) — that turn emits
 * `run:budget_starved`.
 *
 * The oracle is the loop: a compliant fake backend spends at most the output
 * allowance it is given, so what the loop hands out is observable. With the
 * 'go' row (1 token) and the 'sys' system message (1 token), a turn's prompt
 * estimate is exactly 2 tokens, so every remainder below is exact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ensureBudgetPool } from '../lib/agentic/budget-pool.mjs';
import { attachSessionPool } from '../lib/agentic/pooled-client.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { ERROR_CODES } from '../lib/core/constants/index.mjs';
import { AbortedError, BudgetExceededError } from '../lib/core/errors.mjs';
import { resetLimits, setLimits } from '../lib/core/limit-config.mjs';

/** @returns {{promise: Promise<void>, resolve: () => void}} */
function deferred() {
    /** @type {() => void} */
    let resolve = () => {};
    const promise = new Promise((/** @type {(value: void) => void} */ r) => { resolve = () => r(); });
    return { promise, resolve: () => resolve() };
}

/** @param {number} ms @returns {Promise<void>} */
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A child session that reports a fixed prompt and spends up to `need` output
 * tokens, never more than the allowance it was given (a compliant backend).
 * `gate` holds the call in flight so two loops overlap. `nested` starts a child
 * run INSIDE the step, while this turn's reservation is still held (the real
 * `task` tool shape).
 * @param {{need: number, prompt?: number, gate?: {promise: Promise<void>}|null, onStep?: (() => void)|null, nested?: {session: any, outcome: any}|null}} arg0
 * @returns {any}
 */
function worker({ need, prompt = 1, gate = null, onStep = null, nested = null }) {
    const session = {
        provider: 'openai',
        model: 'worker',
        client: { session: () => { throw new Error('no child sessions'); } },
        eventEmitter: new EventEmitter(),
        _tools: [],
        _lastStepMessages: [],
        calls: 0,
        /** @type {Array<number|null>} */
        maxOutputs: [],
        /** @type {Array<any>} */
        starved: [],
        /** @type {Array<any>} */
        exceeded: [],
        withToolAllowlist() { return session; },
        withSystemMessage() { return session; },
        withTools() { return session; },
        getSystemMessage() { return 'sys'; },
        /** @param {{messages: Array<Object>, options?: any}} arg0 */
        async *step({ messages, options }) {
            session.calls += 1;
            session.maxOutputs.push(options?.maxOutputTokens ?? null);
            onStep?.();
            if (gate) await gate.promise;
            if (nested) {
                nested.outcome = await runAgenticLoop({
                    session: nested.session,
                    messages,
                    opts: { maxIterations: 1, runContext: options?.runContext },
                }).then((answer) => ({ answer, error: null }), (error) => ({ answer: null, error }));
            }
            const out = Math.min(need, Math.max(1, Math.floor(Number(options?.maxOutputTokens ?? need))));
            yield { type: 'quota', data: { prompt_tokens: prompt, completion_tokens: out, total_tokens: prompt + out } };
            const content = 'x'.repeat(out);
            return { done: true, content, messages: [...messages, { role: 'assistant', content }] };
        },
    };
    session.eventEmitter.on(EVENTS.CLIENT.BUDGET_STARVED, (/** @type {any} */ e) => session.starved.push(e));
    session.eventEmitter.on(EVENTS.CLIENT.BUDGET_EXCEEDED, (/** @type {any} */ e) => session.exceeded.push(e));
    return session;
}

/** @param {any} pool @param {any} session */
const join = (pool, session) => attachSessionPool({ session, pool, share: true });

/** @returns {Array<Object>} */
const messages = () => [{ role: 'user', content: 'go' }];

test('B-3/admission: a sibling that never sees a usable share is refused before its call', async () => {
    const pool = ensureBudgetPool({ session: /** @type {any} */ ({ _budget: { maxTotalTokens: 100 } }) });
    if (!pool) throw new Error('the cap must create a pool');

    const entered = deferred();
    const gate = deferred();
    const first = worker({ need: 90, gate, onStep: () => entered.resolve() });
    const second = worker({ need: 90 });
    join(pool, first);
    join(pool, second);

    const firstRun = runAgenticLoop({ session: first, messages: messages(), opts: { maxIterations: 1 } })
        .then((answer) => ({ ok: true, answer }), (error) => ({ ok: false, error }));
    await entered.promise; // the first holds its reservation while the second checks
    const secondRun = runAgenticLoop({ session: second, messages: messages(), opts: { maxIterations: 1 } })
        .then((answer) => ({ ok: true, answer }), (error) => ({ ok: false, error }));
    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);

    assert.equal(first.maxOutputs[0], 98, 'the holder gets the whole remainder (100 - 2 prompt tokens)');
    assert.equal(firstResult.ok, true, 'the holder completes');
    assert.equal(secondResult.ok, false, 'the waiter is refused, never handed a starved allowance');
    const error = /** @type {any} */ (secondResult).error;
    assert.ok(error instanceof BudgetExceededError, 'the refusal is the typed budget error');
    assert.equal(error.code, ERROR_CODES.BUDGET);
    assert.match(String(error.message), /100-token pool/);
    assert.match(String(error.message), /16-token minimum/);
    assert.equal(second.calls, 0, 'the refused turn makes no model call');
    assert.equal(second.maxOutputs.length, 0, 'no allowance below the minimum is handed out');
    assert.equal(second.starved.length, 0, 'a refused turn is not reported starved');
    assert.equal(second.exceeded.length, 1, 'the refusal is announced as run:budget_exceeded');
    assert.equal(pool.reservedTokens, 0, 'no reservation leaked');
    assert.equal(pool.reservedCallers ?? 0, 0, 'no caller slot leaked');
    assert.equal(pool.reservedBy?.size ?? 0, 0, 'no per-run reservation leaked');
});

test('B-3/wait: a second child waits for the in-flight sibling and answers in full', async () => {
    const pool = ensureBudgetPool({ session: /** @type {any} */ ({ _budget: { maxTotalTokens: 100 } }) });
    if (!pool) throw new Error('the cap must create a pool');

    const entered = deferred();
    const gate = deferred();
    const first = worker({ need: 40, gate, onStep: () => entered.resolve() });
    const second = worker({ need: 40 });
    join(pool, first);
    join(pool, second);

    const firstRun = runAgenticLoop({ session: first, messages: messages(), opts: { maxIterations: 1 } });
    await entered.promise; // the first is in flight and reserved
    const secondRun = runAgenticLoop({ session: second, messages: messages(), opts: { maxIterations: 1 } });
    await tick(60); // the second is waiting on the holder's reservation
    gate.resolve();
    const [a, b] = await Promise.all([firstRun, secondRun]);

    assert.equal(first.maxOutputs[0], 98, 'the holder gets the whole remainder');
    assert.equal(a.length, 40);
    assert.equal(second.maxOutputs[0], 57, 'the waiter is granted the share left after the holder charged (100 - 41 - 2)');
    assert.equal(b.length, 40, 'the second child answers in full instead of a starved 16 chars');
    assert.equal(first.starved.length + second.starved.length, 0, 'a waited-for share is not starvation');
    assert.equal(pool.reservedTokens, 0, 'no reservation leaked');
    assert.equal(pool.reservedCallers ?? 0, 0, 'no caller slot leaked');
    assert.equal(pool.reservedBy?.size ?? 0, 0, 'no per-run reservation leaked');
});

test('B-3/ancestor: a delegated child is not blocked by its parent’s in-flight reservation', { timeout: 15_000 }, async () => {
    const pool = ensureBudgetPool({ session: /** @type {any} */ ({ _budget: { maxTotalTokens: 100 } }) });
    if (!pool) throw new Error('the cap must create a pool');

    /** @type {{session: any, outcome: any}} */
    const nested = { session: worker({ need: 40 }), outcome: null };
    const parent = worker({ need: 40, nested });
    join(pool, /** @type {any} */ (parent));
    join(pool, nested.session);

    const started = Date.now();
    const answer = await runAgenticLoop({ session: parent, messages: messages(), opts: { maxIterations: 1 } });
    const elapsed = Date.now() - started;

    assert.equal(answer.length, 40, 'the parent answers in full');
    assert.ok(nested.outcome, 'the child ran (today it times out and refuses)');
    assert.equal(nested.outcome.error, null, `the child is admitted instead of refused: ${nested.outcome.error?.message ?? ''}`);
    assert.equal(nested.outcome.answer.length, 40, 'the child answers in full');
    assert.ok((nested.session.maxOutputs[0] ?? 0) >= 40, `the child gets a usable allowance (got ${nested.session.maxOutputs[0]})`);
    assert.ok(elapsed < 1000, `the child does not wait on its ancestor (took ${elapsed} ms)`);
    assert.equal(nested.session.exceeded.length + parent.exceeded.length, 0, 'no refusal is announced');
    assert.equal(pool.reservedTokens, 0, 'no reservation leaked');
    assert.equal(pool.reservedCallers ?? 0, 0, 'no caller slot leaked');
    assert.equal(pool.reservedBy?.size ?? 0, 0, 'no per-run reservation leaked');
});

test('B-3/slow-holder: the default waits past the old 2 s wall for a slow sibling', { timeout: 15_000 }, async () => {
    const pool = ensureBudgetPool({ session: /** @type {any} */ ({ _budget: { maxTotalTokens: 100 } }) });
    if (!pool) throw new Error('the cap must create a pool');

    const entered = deferred();
    const gate = deferred();
    const first = worker({ need: 40, gate, onStep: () => entered.resolve() });
    const second = worker({ need: 40 });
    join(pool, first);
    join(pool, second);

    const firstRun = runAgenticLoop({ session: first, messages: messages(), opts: { maxIterations: 1 } });
    await entered.promise; // the first holds its reservation
    const started = Date.now();
    const secondRun = runAgenticLoop({ session: second, messages: messages(), opts: { maxIterations: 1 } })
        .then((answer) => ({ ok: true, answer }), (error) => ({ ok: false, error }));
    await tick(2_500); // longer than the old 2 s admission wall (which refuses by ~2.2 s wall)
    gate.resolve();
    const [firstAnswer, secondResult] = await Promise.all([firstRun, secondRun]);
    const waited = Date.now() - started;

    assert.equal(firstAnswer.length, 40);
    assert.equal(secondResult.ok, true, `the sibling waits instead of refusing: ${/** @type {any} */ (secondResult).error?.message ?? ''}`);
    assert.ok(waited >= 2_400, `the sibling actually waited for the holder (waited ${waited} ms)`);
    assert.equal(/** @type {any} */ (secondResult).answer.length, 40, 'the sibling answers in full');
    assert.equal(second.maxOutputs[0], 57, 'the sibling gets the share left after the holder charged');
    assert.equal(second.exceeded.length + second.starved.length, 0, 'a waited-for share is neither a refusal nor starvation');
    assert.equal(pool.reservedTokens, 0, 'no reservation leaked');
    assert.equal(pool.reservedCallers ?? 0, 0, 'no caller slot leaked');
    assert.equal(pool.reservedBy?.size ?? 0, 0, 'no per-run reservation leaked');
});

test('B-3/lone: a lone child under a nearly spent cap keeps the whole remainder', async () => {
    const pool = ensureBudgetPool({ session: /** @type {any} */ ({ _budget: { maxTotalTokens: 100 } }) });
    if (!pool) throw new Error('the cap must create a pool');
    pool.usage.prompt_tokens = 60;
    pool.usage.total_tokens = 60;

    const only = worker({ need: 40 });
    join(pool, only);

    const answer = await runAgenticLoop({ session: only, messages: messages(), opts: { maxIterations: 1 } });

    assert.equal(only.maxOutputs[0], 38, 'the lone caller gets the whole remainder (100 - 60 spent - 2 prompt)');
    assert.equal(answer.length, 38);
    assert.equal(only.starved.length, 0, 'a usable allowance is never reported starved');
    assert.equal(only.exceeded.length, 0);
    assert.equal(pool.usage.total_tokens, 99, 'the spend stays under the cap');
});

test('B-3/sequential: a second delegated child that starts after the first keeps the remainder', async () => {
    const pool = ensureBudgetPool({ session: /** @type {any} */ ({ _budget: { maxTotalTokens: 100 } }) });
    if (!pool) throw new Error('the cap must create a pool');

    const first = worker({ need: 40 });
    const second = worker({ need: 40 });
    join(pool, first);
    join(pool, second);

    await runAgenticLoop({ session: first, messages: messages(), opts: { maxIterations: 1 } });
    const answer = await runAgenticLoop({ session: second, messages: messages(), opts: { maxIterations: 1 } });

    assert.equal(first.maxOutputs[0], 98, 'the first child gets the whole remainder');
    assert.equal(second.maxOutputs[0], 57, 'the second child gets the remainder after the first charged');
    assert.equal(answer.length, 40, 'a sequential sibling is not starved by the finished one');
    assert.equal(first.starved.length + second.starved.length, 0, 'no starvation event for sequential children');
});

test('B-3/near-spent: a lone turn in a shared pool with no sibling keeps the remainder and is reported', async () => {
    const pool = ensureBudgetPool({ session: /** @type {any} */ ({ _budget: { maxTotalTokens: 100 } }) });
    if (!pool) throw new Error('the cap must create a pool');

    const first = worker({ need: 90 });
    const second = worker({ need: 90 });
    join(pool, first);
    join(pool, second);

    await runAgenticLoop({ session: first, messages: messages(), opts: { maxIterations: 1 } });
    // No sibling is in flight now: the second turn must not sit out the whole
    // admission window waiting for capacity that nobody holds.
    const started = Date.now();
    const answer = await runAgenticLoop({ session: second, messages: messages(), opts: { maxIterations: 1 } });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 1000, `a lone turn does not wait for a sibling (took ${elapsed} ms)`);
    assert.ok(second.maxOutputs[0] <= 9, `the turn keeps the small remainder (got ${second.maxOutputs[0]})`);
    assert.equal(answer.length, second.maxOutputs[0], 'it proceeds with that remainder rather than refusing');
    assert.equal(second.starved.length, 1, 'the small allowance is reported as starved');
    assert.equal(second.exceeded.length, 0);
});

test('B-3/cap: the optional admission cap still refuses a waiting sibling', { timeout: 5_000 }, async () => {
    const pool = ensureBudgetPool({ session: /** @type {any} */ ({ _budget: { maxTotalTokens: 100 } }) });
    if (!pool) throw new Error('the cap must create a pool');
    setLimits({ values: { budget_admission_wait_ms: 50 } });

    const entered = deferred();
    const gate = deferred();
    const first = worker({ need: 90, gate, onStep: () => entered.resolve() });
    const second = worker({ need: 90 });
    join(pool, first);
    join(pool, second);

    try {
        const firstRun = runAgenticLoop({ session: first, messages: messages(), opts: { maxIterations: 1 } });
        await entered.promise;
        const error = await runAgenticLoop({ session: second, messages: messages(), opts: { maxIterations: 1 } })
            .then(() => null, (/** @type {unknown} */ e) => e);

        assert.ok(error instanceof BudgetExceededError, 'the waiter refuses at the deadline');
        assert.equal(/** @type {any} */ (error).code, ERROR_CODES.BUDGET);
        assert.equal(second.calls, 0, 'no model call is made for the refused turn');
        assert.equal(second.exceeded.length, 1, 'the refusal is announced');

        gate.resolve();
        await firstRun;
        assert.equal(first.maxOutputs[0], 98, 'the holder was never made to wait on the waiter');
        assert.equal(pool.reservedTokens, 0, 'no reservation leaked');
        assert.equal(pool.reservedCallers ?? 0, 0, 'no caller slot leaked');
        assert.equal(pool.reservedBy?.size ?? 0, 0, 'no per-run reservation leaked');
    } finally {
        gate.resolve();
        resetLimits();
    }
});

test('B-3/abort: an abort while waiting is AbortedError and leaks no counters', { timeout: 5_000 }, async () => {
    const pool = ensureBudgetPool({ session: /** @type {any} */ ({ _budget: { maxTotalTokens: 100 } }) });
    if (!pool) throw new Error('the cap must create a pool');

    const entered = deferred();
    const gate = deferred();
    const first = worker({ need: 90, gate, onStep: () => entered.resolve() });
    const second = worker({ need: 90 });
    join(pool, first);
    join(pool, second);

    const controller = new AbortController();
    const firstRun = runAgenticLoop({ session: first, messages: messages(), opts: { maxIterations: 1 } });
    await entered.promise;
    const secondRun = runAgenticLoop({ session: second, messages: messages(), opts: { maxIterations: 1, signal: controller.signal } })
        .then(() => null, (/** @type {unknown} */ e) => e);
    await tick(50); // the second is in the admission wait
    controller.abort();
    const error = await secondRun;

    assert.ok(error instanceof AbortedError, `the wait is aborted, not refused: ${/** @type {any} */ (error)?.message ?? ''}`);
    assert.equal(second.calls, 0, 'no model call is made for the aborted turn');

    gate.resolve();
    await firstRun;
    assert.equal(pool.reservedTokens, 0, 'the holder released its reservation');
    assert.equal(pool.reservedCallers ?? 0, 0, 'the holder released its caller slot');
    assert.equal(pool.reservedBy?.size ?? 0, 0, 'the holder released its per-run reservation');
});
