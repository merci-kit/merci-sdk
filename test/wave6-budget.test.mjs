// @ts-check

/**
 * Wave 6 / SP4 — a shared budget pool and a per-child ledger (D12, closes E2).
 *
 * Check-first: written against the post-SP3 tree. Today each child inherits a
 * COPY of the parent's cap (`task.mjs`: `profile.budget ?? session._budget`), so
 * N children mean N × the cap (E2) and no child's spend is visible to the tree.
 *
 * The oracle is the engine, not the module asserting about itself: a real
 * `runAgenticLoop` on a real session whose `step` reports a known usage, and the
 * spawn record the registry exposes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { withTaskAgents, runTaskChild } from '../lib/agentic/task.mjs';
import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { listSpawns, getSpawnRegistry } from '../lib/agentic/spawn-registry.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { BudgetExceededError } from '../lib/core/errors.mjs';
import { ERROR_CODES } from '../lib/core/constants/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';
import { getBudgetPool } from '../lib/index.mjs';

/** @param {{prompt?: number, completion?: number, cost_usd?: number}} [tokens] */
const quota = (tokens = { prompt: 11, completion: 4 }) => ({
    prompt_tokens: tokens.prompt ?? 0,
    completion_tokens: tokens.completion ?? 0,
    ...(tokens.cost_usd !== undefined ? { cost_usd: tokens.cost_usd } : {}),
});

/**
 * A real child session whose model call reports a fixed usage.
 * @param {{client: any, model?: string, tokens?: Record<string, any>|null, budget?: any}} arg0
 * @returns {any}
 */
function makeChild({ client, model = 'child-model', tokens = quota(), budget = null }) {
    const emitter = new EventEmitter();
    const session = new OaiChatSession({ client, model, eventEmitter: emitter });
    /** @type {any} */ (session).stepCalls = 0;
    // The test replaces the model call.
    /** @type {any} */ (session).step = async function* step() {
        const calls = /** @type {any} */ (session);
        calls.stepCalls += 1;
        if (tokens) yield { type: 'quota', data: tokens };
        return { done: true, content: 'child answer', messages: [{ role: 'assistant', content: 'child answer' }] };
    };
    if (budget) /** @type {any} */ (session)._budget = budget;
    return session;
}

/**
 * A parent session-like that can both run the agentic loop and delegate.
 * @param {{client: any, budget?: any, tokens?: Record<string, any>|null}} arg0
 * @returns {any}
 */
function makeParent({ client, budget = null, tokens = quota() }) {
    const emitter = new EventEmitter();
    const parent = {
        provider: 'openai',
        model: 'parent-model',
        client,
        eventEmitter: emitter,
        /** @type {any[]} */
        _tools: [],
        _taskDepth: 0,
        /** @type {any[]} */
        _lastStepMessages: [],
        /** @type {number} */
        stepCalls: 0,
        withToolAllowlist() { return parent; },
        withSystemMessage() { return parent; },
        withTools() { return parent; },
        // The test replaces the model call.
        step: async function* step() {
            parent.stepCalls += 1;
            if (tokens) yield { type: 'quota', data: tokens };
            return { done: true, content: 'parent answer', messages: [{ role: 'assistant', content: 'parent answer' }] };
        },
    };
    if (budget) /** @type {any} */ (parent)._budget = budget;
    return parent;
}

/**
 * A client whose sessions come from the given factories, plus a parent.
 * @param {{children?: Array<(arg0: {client: any, model: string}) => any>, parentBudget?: any, parentTokens?: any}} [arg0]
 * @returns {{client: any, parent: any, children: any[]}}
 */
function tree({ children = [], parentBudget = null, parentTokens = quota() } = {}) {
    const client = /** @type {any} */ ({ provider: 'openai', emit() { return false; } });
    /** @type {any[]} */
    const built = [];
    let next = 0;
    client.session = (/** @type {string} */ model) => {
        const factory = children[next] ?? children[children.length - 1];
        next += 1;
        const child = factory ? factory({ client, model }) : makeChild({ client, model });
        built.push(child);
        return child;
    };
    const parent = makeParent({ client, budget: parentBudget, tokens: parentTokens });
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'child-model' }] });
    return { client, parent, children: built };
}

/** @param {{client: any}} arg0 */
const profileFor = ({ client }) => /** @type {any} */ (getSpawnRegistry({ client }).agents.get('worker'));

/**
 * @param {{client: any, parent: any, prompt?: string, profile?: any}} arg0
 * @returns {Promise<any>}
 */
const delegate = ({ client, parent, prompt = 'Do X', profile = null }) => runTaskChild({
    session: parent,
    profile: profile ?? profileFor({ client }),
    args: { description: 'x', prompt, subagent_type: 'worker' },
    signal: undefined,
    eventEmitter: parent.eventEmitter,
});

const messages = () => [createUserMessage({ provider: 'openai', content: 'go' })];

/**
 * The pool, as `any`: the tests assert presence where it matters.
 * @param {any} session @returns {any}
 */
const poolOf = (session) => getBudgetPool({ session });

// ─── The pool exists only when a budget does ────────────────────────────────

test('W6B/pool-created: a budgeted session owns a pool; an unbudgeted one has none', () => {
    const budgeted = makeParent({ client: {}, budget: { maxTotalTokens: 100 } });
    const plain = makeParent({ client: {} });
    const pool = poolOf(budgeted);
    assert.ok(pool, 'a budgeted session has a pool');
    assert.equal(pool.maxTotalTokens, 100, 'the cap lives on the pool');
    assert.equal(pool.usage.total_tokens, 0, 'nothing spent yet');
    assert.equal(poolOf(plain), null, 'no budget, no pool');
});

// ─── A child draws from the parent's pool, not from a copy of the cap ───────

test('W6B/child-shares-pool: the child session carries the parent pool by reference', async () => {
    const t = tree({ parentBudget: { maxTotalTokens: 1000 } });
    await delegate({ client: t.client, parent: t.parent });
    const pool = poolOf(t.parent);
    assert.ok(pool, 'the parent has a pool');
    assert.equal(t.children.length, 1, 'one child session was built');
    assert.equal(t.children[0]._budgetPool, t.parent._budgetPool, 'the child draws from the same pool');
});

test('W6B/tree-cap: a child cannot spend past the tree cap the parent already used', async () => {
    // Parent spends 60 of a 100 cap; the child then spends 50. Per-child caps
    // (today) let the child through (50 < 100) and the tree spends 110.
    const t = tree({
        parentBudget: { maxTotalTokens: 100 },
        parentTokens: quota({ prompt: 40, completion: 20 }),
        children: [({ client }) => makeChild({ client, tokens: quota({ prompt: 30, completion: 20 }) })],
    });
    await runAgenticLoop({ session: t.parent, messages: messages() });
    const pool = poolOf(t.parent);
    assert.equal(pool.usage.total_tokens, 60, 'the parent turn charged the pool');

    const error = await delegate({ client: t.client, parent: t.parent }).then(() => null, (/** @type {any} */ e) => e);
    assert.equal(error.code, ERROR_CODES.BUDGET, 'the child fails on the TREE cap, not its own');
    assert.ok(error instanceof BudgetExceededError, 'the typed budget error survives the delegation ladder');
    assert.equal(error.maxTotalTokens, 100, 'the cap is visible on the wrapped error');
    assert.equal(/** @type {any} */ (error).usage.total_tokens, 110, 'the error reports the tree total');
});

test('W6B/child-estimate: a silent child’s record says it was estimated', async () => {
    const t = tree({ parentBudget: { maxTotalTokens: 1000 }, children: [({ client }) => makeChild({ client, tokens: null })] });
    await delegate({ client: t.client, parent: t.parent });
    const [spawn] = listSpawns({ client: t.client });
    assert.ok((spawn.usage?.total_tokens ?? 0) > 0, 'the child’s turn was charged');
    assert.equal(spawn.usage?.estimated, true, 'the record admits the number is an estimate');
    assert.equal(poolOf(t.parent).usage.estimated, true, 'and so does the tree');
});

test('W6B/ledger-split: the pool is the tree ledger, the record is the child ledger', async () => {
    const t = tree({ parentBudget: { maxTotalTokens: 1000 } });
    await delegate({ client: t.client, parent: t.parent });
    const [spawn] = listSpawns({ client: t.client });
    const pool = poolOf(t.parent);
    assert.equal(spawn.usage?.total_tokens, 15, 'the record holds the child’s own 11 + 4');
    assert.equal(pool.usage.total_tokens, 15, 'the pool holds the same spend (the parent spent nothing)');
});

test('W6B/parent-blocked: the parent’s next turn stops before the model call once the tree is spent', async () => {
    const t = tree({
        parentBudget: { maxTotalTokens: 100 },
        children: [({ client }) => makeChild({ client, tokens: quota({ prompt: 60, completion: 40 }) })],
    });
    await delegate({ client: t.client, parent: t.parent, prompt: 'spend it all' });
    const pool = poolOf(t.parent);
    assert.equal(pool.usage.total_tokens, 100, 'the child charged the whole cap');
    const calls = t.parent.stepCalls;
    const error = await runAgenticLoop({ session: t.parent, messages: messages() })
        .then(() => null, (/** @type {any} */ e) => e);
    assert.ok(error instanceof BudgetExceededError, 'rejected');
    assert.equal(pool.usage.total_tokens, 100, 'the blocked turn cost nothing');
    assert.equal(t.parent.stepCalls, calls, 'the model was never called');
});

// ─── The tree cannot be dodged by a silent or a greedy child ────────────────

test('W6B/estimation: a step that reports no usage still charges the pool', async () => {
    const t = tree({ parentBudget: { maxTotalTokens: 1000 }, parentTokens: null });
    await runAgenticLoop({ session: t.parent, messages: messages() });
    const pool = poolOf(t.parent);
    assert.ok(pool.usage.total_tokens > 0, 'an estimate was charged');
    assert.ok(pool.usage.estimated_tokens > 0, 'the estimated amount is visible, not just a flag');
    assert.equal(pool.usage.estimated_tokens, pool.usage.total_tokens, 'nothing reported, so the total IS the estimate');
    assert.equal(pool.usage.estimated, true, 'and it is flagged as an estimate');
});

test('W6B/siblings-share: two children draw from one pool in sequence', async () => {
    const t = tree({
        parentBudget: { maxTotalTokens: 100 },
        children: [
            ({ client }) => makeChild({ client, tokens: quota({ prompt: 40, completion: 30 }) }),
            ({ client }) => makeChild({ client, tokens: quota({ prompt: 30, completion: 10 }) }),
        ],
    });
    const first = await delegate({ client: t.client, parent: t.parent });
    assert.ok(first, 'the first child ran');
    const second = await delegate({ client: t.client, parent: t.parent }).then(() => null, (/** @type {any} */ e) => e);
    assert.equal(second.code, ERROR_CODES.BUDGET, 'the second child sees the first child’s spend');
    assert.equal(poolOf(t.parent).usage.total_tokens, 110, '70 + 40');
});

test('W6B/override-local: a per-child budget is a tighter local cap, not a new tree cap', async () => {
    const t = tree({
        parentBudget: { maxTotalTokens: 1000 },
        children: [({ client }) => makeChild({ client, tokens: quota({ prompt: 40, completion: 20 }) })],
    });
    const tighter = { ...profileFor({ client: t.client }), budget: { maxTotalTokens: 30 } };
    const error = await delegate({ client: t.client, parent: t.parent, profile: tighter })
        .then(() => null, (/** @type {any} */ e) => e);
    assert.equal(error.code, ERROR_CODES.BUDGET, 'the tighter local cap stops the child');
    assert.equal(poolOf(t.parent).maxTotalTokens, 1000, 'the tree cap is untouched');
    assert.equal(poolOf(t.parent).usage.total_tokens, 60, 'but the spend is in the pool');
});

// ─── Caps move with the owner, never with a child ───────────────────────────

test('W6B/owner-updates: withBudget moves the tree cap on the owner only', async () => {
    const t = tree({ parentBudget: { maxTotalTokens: 1000 } });
    await delegate({ client: t.client, parent: t.parent });
    assert.equal(poolOf(t.parent).maxTotalTokens, 1000);
    const child = t.children[0];
    child.withBudget({ budget: { maxTotalTokens: 7 } });
    assert.equal(poolOf(t.parent).maxTotalTokens, 1000, 'a child never moves the tree cap');
    assert.equal(child._budget.maxTotalTokens, 7, 'the child kept its own tighter cap');
    // The owner moving its own cap moves the tree cap.
    const owner = new OaiChatSession({ client: t.client, model: 'p', eventEmitter: new EventEmitter() });
    owner.withBudget({ budget: { maxTotalTokens: 100 } });
    assert.equal(poolOf(owner).maxTotalTokens, 100);
    owner.withBudget({ budget: { maxTotalTokens: 50 } });
    assert.equal(poolOf(owner).maxTotalTokens, 50, 'the owner changed the tree cap');
});

// ─── Money, and the unbudgeted default ─────────────────────────────────────

test('W6B/usd-tree: reported cost is summed across the tree and enforced', async () => {
    const t = tree({
        parentBudget: { maxBudgetUsd: 1 },
        children: [
            ({ client }) => makeChild({ client, tokens: quota({ prompt: 1, completion: 1, cost_usd: 0.6 }) }),
            ({ client }) => makeChild({ client, tokens: quota({ prompt: 1, completion: 1, cost_usd: 0.5 }) }),
        ],
    });
    await delegate({ client: t.client, parent: t.parent });
    const error = await delegate({ client: t.client, parent: t.parent }).then(() => null, (/** @type {any} */ e) => e);
    assert.equal(error.code, ERROR_CODES.BUDGET, 'the second child crosses the tree’s dollar cap');
    assert.equal((/** @type {any} */ (error)).maxBudgetUsd, 1, 'the USD cap is on the error');
    assert.equal((/** @type {any} */ (error)).costUsd, 1.1, 'and the tree cost that crossed it');
    assert.ok(poolOf(t.parent).usage.cost_usd >= 1, 'the tree cost is summed');
});

test('W6B/no-budget: without a budget there is no pool and nothing is capped', async () => {
    const t = tree({ parentTokens: quota({ prompt: 5000, completion: 5000 }) });
    await runAgenticLoop({ session: t.parent, messages: messages() });
    assert.equal(poolOf(t.parent), null, 'no pool');
    const result = await delegate({ client: t.client, parent: t.parent });
    assert.equal(result, 'child answer', 'a child runs freely');
    assert.equal(t.children[0]._budgetPool, undefined, 'and it carries no pool');
});

test('W6B/event-usage: the exceeded event carries the tree totals and the cap that fired', async () => {
    const t = tree({
        parentBudget: { maxTotalTokens: 100 },
        children: [({ client }) => makeChild({ client, tokens: quota({ prompt: 60, completion: 40 }) })],
    });
    await delegate({ client: t.client, parent: t.parent });
    /** @type {any[]} */
    const events = [];
    t.parent.eventEmitter.on(EVENTS.CLIENT.BUDGET_EXCEEDED, (/** @type {any} */ e) => events.push(e));
    await assert.rejects(() => runAgenticLoop({ session: t.parent, messages: messages() }), BudgetExceededError);
    assert.equal(events.length, 1);
    assert.equal(events[0].maxTotalTokens, 100, 'the tree cap fired');
    assert.equal(events[0].usage.total_tokens, 100, 'and the usage is the tree total, which includes the child');
});
