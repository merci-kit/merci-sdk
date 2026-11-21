// @ts-check
/**
 * B-1: a delegated child with its own budget must still be bound by the tree
 * cap. Before the fix the loop enforced only `ensureBudgetPool({ session })`,
 * so a child budget of 5000 with a tree cap of 100 spent 200 and resolved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ensureBudgetPool, getPoolParent } from '../lib/agentic/budget-pool.mjs';
import { attachSessionPool } from '../lib/agentic/pooled-client.mjs';
import { BudgetExceededError } from '../lib/core/errors.mjs';

/** @param {{tokens?: number, onCall?: () => void}} [arg0] @returns {any} */
function sessionWithUsage({ tokens = 40, onCall } = {}) {
    const emitter = new EventEmitter();
    const session = {
        provider: 'openai',
        model: 'm',
        client: { session: () => { throw new Error('client must not be called'); } },
        eventEmitter: emitter,
        _tools: [{ name: 'noop', description: 'no-op', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: true }) }],
        _lastStepMessages: [],
        calls: 0,
        withToolAllowlist() { return session; },
        withSystemMessage() { return session; },
        withTools() { return session; },
        /** @param {{messages: any[]}} arg0 */
        async *step({ messages }) {
            const n = session.calls += 1;
            onCall?.();
            yield { type: 'quota', data: { prompt_tokens: tokens - 1, completion_tokens: 1, total_tokens: tokens } };
            yield { type: 'tool_request', calls: [{ id: `c${n}`, name: 'noop', args: { n } }] };
            const toolRow = { role: 'assistant', content: '', tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'noop', arguments: JSON.stringify({ n }) } }] };
            return { done: true, content: '', messages: [...messages, toolRow] };
        },
    };
    return session;
}

test('a child with its own larger budget is refused at the tree cap', async () => {
    const parent = sessionWithUsage({ tokens: 1 });
    parent._budget = { maxTotalTokens: 100 };
    const parentPool = ensureBudgetPool({ session: parent });
    assert.ok(parentPool);

    const child = sessionWithUsage({ tokens: 40 });
    child._budget = { maxTotalTokens: 5_000 };
    // Exactly what task.mjs does for a profile-owned budget.
    attachSessionPool({ session: child, pool: parentPool, share: true, ownBudget: true });
    assert.equal(getPoolParent({ pool: child._budgetPool }), parentPool, 'the child pool must report upward');

    await assert.rejects(
        () => runAgenticLoop({ session: child, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 5 } }),
        (err) => err instanceof BudgetExceededError && /100/.test(String(err.message)),
    );
    assert.ok(child.calls <= 3, `the tree cap stops the child, calls=${child.calls}`);
    assert.ok(parentPool.usage.total_tokens > 100, 'one-call overshoot is the documented allowance');
    assert.ok(parentPool.usage.total_tokens <= 120, `overshoot bounded by one call, got ${parentPool.usage.total_tokens}`);
});

test('a child budget tighter than the tree still binds first', async () => {
    const parent = sessionWithUsage({ tokens: 1 });
    parent._budget = { maxTotalTokens: 1_000 };
    const parentPool = ensureBudgetPool({ session: parent });
    if (!parentPool) throw new Error('the parent budget must create a pool');
    const child = sessionWithUsage({ tokens: 40 });
    child._budget = { maxTotalTokens: 50 };
    attachSessionPool({ session: child, pool: parentPool, share: true, ownBudget: true });

    await assert.rejects(
        () => runAgenticLoop({ session: child, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 5 } }),
        BudgetExceededError,
    );
    // B-7: after the first call the projection is the prompt the backend billed
    // (39 tokens), so the 50-token local cap refuses the NEXT call before it is
    // made — one call, not two.
    assert.equal(child.calls, 1, 'the local 50-token cap refuses the second call before it is made');
    assert.ok(parentPool.usage.total_tokens <= 80);
});

test('two concurrent children cannot both spend the remainder (B-3, compliant backend)', async () => {
    const parent = sessionWithUsage({ tokens: 1 });
    parent._budget = { maxTotalTokens: 100 };
    const parentPool = ensureBudgetPool({ session: parent });
    if (!parentPool) throw new Error('pool');

    /** @param {number} id */
    const child = (id) => {
        const s = sessionWithUsage({ tokens: 0 });
        s._budget = { maxTotalTokens: 1_000 };
        // A compliant backend spends exactly the output budget it was given.
        const baseStep = s.step;
        s.step = async function* (/** @type {any} */ { messages, options }) {
            s.calls += 1;
            const out = Math.max(1, Math.floor(Number(options?.maxOutputTokens ?? 1)));
            yield { type: 'quota', data: { prompt_tokens: 0, completion_tokens: out, total_tokens: out } };
            return { done: true, content: `answer-${id}`, messages: [...messages, { role: 'assistant', content: `answer-${id}` }] };
        };
        void baseStep;
        attachSessionPool({ session: s, pool: parentPool, share: true, ownBudget: true });
        return s;
    };
    const a = child(1);
    const b = child(2);
    const results = await Promise.allSettled([
        runAgenticLoop({ session: a, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 1 } }),
        runAgenticLoop({ session: b, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 1 } }),
    ]);
    assert.ok(parentPool.usage.total_tokens <= 101, `the shared cap holds, got ${parentPool.usage.total_tokens}`);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length >= 1, true);
});

test('a synchronous step() throw releases the in-flight reservation (B-3)', async () => {
    const parent = sessionWithUsage({ tokens: 1 });
    parent._budget = { maxTotalTokens: 100 };
    const parentPool = ensureBudgetPool({ session: parent });
    if (!parentPool) throw new Error('the parent budget must create a pool');

    const child = sessionWithUsage({ tokens: 1 });
    child._budget = { maxTotalTokens: 1_000 };
    // A non-conforming host session: a plain function, not an async generator.
    child.step = () => { throw new Error('boom'); };
    attachSessionPool({ session: child, pool: parentPool, share: true, ownBudget: true });

    await assert.rejects(
        () => runAgenticLoop({ session: child, messages: [{ role: 'user', content: 'go' }], opts: { maxIterations: 1 } }),
        /boom/,
    );
    assert.equal(parentPool.reservedTokens ?? 0, 0, 'the reservation is released when step throws');
});
