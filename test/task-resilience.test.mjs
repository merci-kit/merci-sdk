// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createTaskTool, withTaskAgents } from '../lib/agentic/task.mjs';
import { ExponentialBackoffPolicy, CircuitBreaker } from '../lib/support/retry-policy.mjs';

/**
 * @param {{model: any, runFn: Function}} arg0
 * @returns {any}
 */
function fakeChild({ model, runFn }) {
    const s = {
        provider: 'jai',
        model,
        runCalls: /** @type {any[]} */ ([]),
        withSystemMessage() { return s; },
        withTools() { return s; },
        /** @param {{policy: *}} arg0 */
        withRetryPolicy({ policy }) { (/** @type {any} */ (s))._retryPolicy = policy; return s; },
        /** @param {{ms: *}} arg0 */
        withHeaderTimeout({ ms }) { (/** @type {any} */ (s))._headerTimeoutMs = ms; return s; },
        /** @param {{ms: *}} arg0 */
        withMaxElapsedMs({ ms }) { (/** @type {any} */ (s))._maxElapsedMs = ms; return s; },
        /** @param {{breaker: *}} arg0 */
        withCircuitBreaker({ breaker }) { (/** @type {any} */ (s))._circuitBreaker = breaker; return s; },
        /** @param {{fn: *, options: *}} arg0 */
        withApproval({ fn, options }) { (/** @type {any} */ (s))._approvalPolicy = { callback: fn, timeoutMs: options?.timeoutMs }; return s; },
        /** @param {{budget: *}} arg0 */
        withBudget({ budget }) { (/** @type {any} */ (s))._budget = budget; return s; },
        /** @param {{initialInput: *, options: *}} arg0 */
        async run({ initialInput: msgs, options: opts }) {
            s.runCalls.push({ msgs, opts });
            return runFn(s, msgs, opts);
        },
    };
    return s;
}

/**
 * @param {{profiles: any, runByModel: any}} arg0
 * @returns {any}
 */
function fakeRig({ profiles, runByModel }) {
    const client = {
        children: /** @type {any[]} */ ([]),
        /** @param {any} model */
        session(model) {
            const child = fakeChild({ model, runFn: runByModel[model] ?? (async () => 'default-ok') });
            client.children.push(child);
            return child;
        },
    };
    withTaskAgents({ client: /** @type {any} */ (client), agents: profiles });
    return client;
}

/**
 * @param {{client: any, extras?: any}} arg0
 * @returns {any}
 */
function parentSession({ client, extras = {} }) {
    return {
        client,
        model: 'parent-model',
        provider: 'jai',
        sessionId: 'parent-1',
        eventEmitter: new EventEmitter(),
        _taskDepth: 0,
        ...extras,
    };
}

/**
 * @param {{emitter: any}} arg0
 */
function collectEvents({ emitter }) {
    /** @type {any[]} */
    const seen = [];
    for (const t of ['task:finish', 'task:error', 'task:fallback', 'task:hedge']) {
        emitter.on(t, (/** @type {any} */ e) => seen.push({ type: t, ...e }));
    }
    return seen;
}

const baseArgs = { prompt: 'do it', subagent_type: 'writer', description: 'write' };

test('task child inherits the parent retryPolicy; profile.retryPolicy wins', async () => {
    const parentPolicy = new ExponentialBackoffPolicy();
    const profilePolicy = new ExponentialBackoffPolicy({ maxRetries: 1 });
    const client = fakeRig({ profiles: [
        { name: 'writer', model: 'm1' },
        { name: 'biased', model: 'm2', retryPolicy: profilePolicy },
    ], runByModel: {} });
    const parent = parentSession({ client, extras: { _retryPolicy: parentPolicy } });
    await (/** @type {any} */ (createTaskTool({ session: parent }))).execute({ args: { ...baseArgs }, context: {} });
    await (/** @type {any} */ (createTaskTool({ session: parent }))).execute({ args: { ...baseArgs, subagent_type: 'biased' }, context: {} });
    assert.equal(client.children[0]._retryPolicy, parentPolicy, 'inherits parent policy');
    assert.equal(client.children[1]._retryPolicy, profilePolicy, 'profile policy wins');
});

test('task child inherits timeoutMs / maxElapsedMs overrides', async () => {
    const client = fakeRig({ profiles: [{ name: 'writer', model: 'm1', timeoutMs: 60_000, maxElapsedMs: 120_000 }], runByModel: {} });
    const parent = parentSession({ client, extras: { _headerTimeoutMs: 5000, _maxElapsedMs: 7000 } });
    await (/** @type {any} */ (createTaskTool({ session: parent }))).execute({ args: { ...baseArgs }, context: {} });
    assert.equal(client.children[0]._headerTimeoutMs, 60_000, 'profile timeoutMs wins');
    assert.equal(client.children[0]._maxElapsedMs, 120_000, 'profile maxElapsedMs wins');
});

test('task child inherits the parent approval gate and token budget', async () => {
    const parentApproval = { callback: async () => true, timeoutMs: 1000 };
    const parentBudget = { maxTotalTokens: 500 };
    const client = fakeRig({ profiles: [{ name: 'writer', model: 'm1' }], runByModel: {} });
    const parent = parentSession({ client, extras: { _approvalPolicy: parentApproval, _budget: parentBudget } });
    await (/** @type {any} */ (createTaskTool({ session: parent }))).execute({ args: { ...baseArgs }, context: {} });
    assert.deepEqual(client.children[0]._approvalPolicy, parentApproval, 'inherits parent approval gate');
    assert.deepEqual(client.children[0]._budget, parentBudget, 'inherits parent token budget');
});

test('task profile approval/budget override the parent, and a plain parent sets neither', async () => {
    const profileApproval = { callback: async () => false, timeoutMs: 2000 };
    const profileBudget = { maxTotalTokens: 50 };
    const client = fakeRig({ profiles: [{ name: 'gated', model: 'm2', approval: profileApproval, budget: profileBudget }], runByModel: {} });
    const parent = parentSession({ client, extras: {
        _approvalPolicy: { callback: async () => true, timeoutMs: 1000 },
        _budget: { maxTotalTokens: 500 },
    } });
    await (/** @type {any} */ (createTaskTool({ session: parent }))).execute({ args: { ...baseArgs, subagent_type: 'gated' }, context: {} });
    assert.deepEqual(client.children[0]._approvalPolicy, profileApproval, 'profile approval wins');
    assert.deepEqual(client.children[0]._budget, profileBudget, 'profile budget wins');

    const plainClient = fakeRig({ profiles: [{ name: 'writer', model: 'm1' }], runByModel: {} });
    await (/** @type {any} */ (createTaskTool({ session: parentSession({ client: plainClient }) }))).execute({ args: { ...baseArgs }, context: {} });
    assert.equal(plainClient.children[0]._approvalPolicy, undefined, 'gate-less parent adds no gate');
    assert.equal(plainClient.children[0]._budget, undefined, 'uncapped parent adds no budget');
});

test('task falls back to fallbackModel on transient failure and emits task:fallback', async () => {
    const client = fakeRig({ profiles: [{ name: 'writer', model: 'primary', fallbackModel: 'cheap' }], runByModel: {
        primary: async () => { throw Object.assign(new Error('boom'), { status: 503 }); },
        cheap: async () => 'fallback-ok',
    } });
    const parent = parentSession({ client });
    const events = collectEvents({ emitter: parent.eventEmitter });
    const out = await (/** @type {any} */ (createTaskTool({ session: parent }))).execute({ args: { ...baseArgs }, context: {} });
    assert.equal(out, 'fallback-ok');
    assert.ok(events.some((e) => e.type === 'task:fallback' && e.fallbackModel === 'cheap'), 'fallback event emitted');
    assert.ok(events.some((e) => e.type === 'task:finish'), 'finish emitted after fallback');
});

test('task does NOT fall back on permanent (400) failure; error carries a Hint', async () => {
    const client = fakeRig({ profiles: [{ name: 'writer', model: 'primary', fallbackModel: 'cheap' }], runByModel: {
        primary: async () => { throw Object.assign(new Error('bad request'), { status: 400 }); },
        cheap: async () => 'must-not-run',
    } });
    const parent = parentSession({ client });
    const tool = /** @type {any} */ (createTaskTool({ session: parent }));
    await assert.rejects(() => tool.execute({ args: { ...baseArgs }, context: {} }), /Hint:/);
    assert.equal(client.children.length, 1, 'fallback never attempted for 400');
});

test('task skips a breaker-open primary and uses the fallback directly', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.canRun(), false);
    let primaryCalls = 0;
    const client = fakeRig({ profiles: [{ name: 'writer', model: 'primary', fallbackModel: 'cheap', circuitBreaker: breaker }], runByModel: {
        primary: async () => { primaryCalls++; return 'primary-ok'; },
        cheap: async () => 'fallback-ok',
    } });
    const parent = parentSession({ client });
    const out = await (/** @type {any} */ (createTaskTool({ session: parent }))).execute({ args: { ...baseArgs }, context: {} });
    assert.equal(out, 'fallback-ok');
    assert.equal(primaryCalls, 0, 'open breaker skips the primary entirely');
});

test('task breaker-open with no fallback throws an actionable error', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    breaker.recordFailure();
    const client = fakeRig({ profiles: [{ name: 'writer', model: 'primary', circuitBreaker: breaker }], runByModel: {
        primary: async () => 'primary-ok',
    } });
    const parent = parentSession({ client });
    await assert.rejects(() => (/** @type {any} */ (createTaskTool({ session: parent }))).execute({ args: { ...baseArgs }, context: {} }), /Circuit breaker open|Hint:/);
});

test('task hedge: slow first attempt loses to the fast hedge; task:hedge emitted', async () => {
    const client = fakeRig({ profiles: [{ name: 'writer', model: 'm1', hedgeAfterMs: 10 }], runByModel: {} });
    let n = 0;
    client.session = (/** @type {any} */ model) => {
        n++;
        const mine = n;
        const child = fakeChild({ model, runFn: async () => (mine === 1
            ? new Promise((r) => setTimeout(() => r('slow'), 80))
            : Promise.resolve('fast')) });
        client.children.push(child);
        return child;
    };
    const parent = parentSession({ client });
    const events = collectEvents({ emitter: parent.eventEmitter });
    const out = await (/** @type {any} */ (createTaskTool({ session: parent }))).execute({ args: { ...baseArgs }, context: {} });
    assert.equal(out, 'fast', 'first finished attempt wins');
    assert.ok(events.some((e) => e.type === 'task:hedge'), 'hedge event emitted');
});

test('task exhaustion error names the tried chain and a timeout hint', async () => {
    const client = fakeRig({ profiles: [{ name: 'writer', model: 'primary', fallbackModel: 'cheap' }], runByModel: {
        primary: async () => {
            const e = new Error('JAI gateway did not respond with headers within 600000ms (header timeout)');
            (/** @type {any} */ (e)).code = 'HEADER_TIMEOUT';
            throw e;
        },
        cheap: async () => { throw Object.assign(new Error('still down'), { status: 503 }); },
    } });
    const parent = parentSession({ client });
    await assert.rejects(
        () => (/** @type {any} */ (createTaskTool({ session: parent }))).execute({ args: { ...baseArgs }, context: {} }),
        (/** @type {any} */ e) => /Subagent "writer" failed/.test(e.message) && /Hint:/.test(e.message),
        'exhaustion names the subagent and carries a hint',
    );
});

test('task: an empty-output child degrades to profile.fallbackModel', async () => {
    const client = fakeRig({ profiles: [{ name: 'writer', model: 'primary', fallbackModel: 'cheap' }], runByModel: {
        primary: async () => '',
        cheap: async () => 'fallback-ok',
    } });
    const parent = parentSession({ client });
    const events = collectEvents({ emitter: parent.eventEmitter });
    const out = await (/** @type {any} */ (createTaskTool({ session: parent }))).execute({ args: { ...baseArgs }, context: {} });
    assert.equal(out, 'fallback-ok', 'the fallback model rescues an empty answer');
    assert.equal(client.children.length, 2, 'primary + fallback child');
    const fallback = events.find((e) => e.type === 'task:fallback');
    assert.ok(fallback, 'task:fallback emitted');
    assert.equal(fallback.reason, 'empty-output');
    assert.equal(fallback.fallbackModel, 'cheap');
});

test('task: empty-output exhaustion hint names the empty answer (no dead-end fallback advice)', async () => {
    const client = fakeRig({ profiles: [{ name: 'writer', model: 'primary' }], runByModel: {
        primary: async () => '   ',
    } });
    const parent = parentSession({ client });
    await assert.rejects(
        () => (/** @type {any} */ (createTaskTool({ session: parent }))).execute({ args: { ...baseArgs }, context: {} }),
        (/** @type {any} */ e) => /answered empty/.test(e.message) && /fallbackModel/.test(e.message),
        'the hint must match the actual failure class',
    );
});

test('task: when primary and fallback both answer empty, the exhaustion error is typed and honest', async () => {
    const client = fakeRig({ profiles: [{ name: 'writer', model: 'primary', fallbackModel: 'cheap' }], runByModel: {
        primary: async () => '',
        cheap: async () => '   ',
    } });
    const parent = parentSession({ client });
    await assert.rejects(
        () => (/** @type {any} */ (createTaskTool({ session: parent }))).execute({ args: { ...baseArgs }, context: {} }),
        (/** @type {any} */ e) => e.code === 'EMPTY_OUTPUT' && /both the primary and fallback/.test(e.message),
        'the typed cause and an accurate hint survive the fallback attempt',
    );
});

test('task: empty output does not trip the shared circuit breaker', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    const client = fakeRig({ profiles: [{ name: 'writer', model: 'primary', circuitBreaker: breaker }], runByModel: {
        primary: async () => '',
    } });
    const parent = parentSession({ client });
    await assert.rejects(
        () => (/** @type {any} */ (createTaskTool({ session: parent }))).execute({ args: { ...baseArgs }, context: {} }),
        /no usable output/,
    );
    assert.equal(breaker.canRun(), true, 'a model-quality empty must not open the transport breaker');
});
