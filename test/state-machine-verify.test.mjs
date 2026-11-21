// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StateMachine } from '../lib/agentic/state-machine/index.mjs';
import { FailureClass } from '../lib/agentic/loops/index.mjs';
import { FALLBACK_MESSAGE } from '../lib/core/constants/index.mjs';

// ─── Per-node verify: pass / fail / retry ───────────────────────────────────

test('verify: passing check resolves the transition normally', async () => {
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [
            {
                id: 'gen',
                execute: () => 'valid',
                verify: /** @type {(out: any) => any} */ ((out) => ({ passed: out === 'valid', evidence: out }))
            },
            { id: 'done', execute: () => {}, terminal: true }
        ],
        edges: [{ from: 'gen', to: 'done' }]
    } });
    const events = /** @type {any[]} */ ([]);
    sm.on('state_machine:verify_start', (e) => events.push(['start', e.nodeId]));
    sm.on('state_machine:verify_pass', (e) => events.push(['pass', e.nodeId]));
    await sm.run();
    assert.equal(sm.phase, 'done');
    assert.deepEqual(events, [['start', 'gen'], ['pass', 'gen']]);
});

test('verify: a failing check exhausts the global attempt cap (default 2 retries = 3 attempts), then escalates', async () => {
    let calls = 0;
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{
            id: 'gen',
            execute: () => { calls++; return 'bad'; },
            verify: () => ({ passed: false, evidence: 'ValueError' }),
            terminal: true
        }],
        edges: []
    } });
    const escalated = /** @type {any[]} */ ([]);
    sm.on('state_machine:escalated', (e) => escalated.push(e));
    await assert.rejects(() => sm.run(), { message: /failed verification \(no_progress\)/ });
    assert.equal(calls, 3, 'maxRetries default 2 → 3 attempts (global, not per fingerprint)');
    assert.equal(sm.phase, 'escalated');
    assert.equal(escalated.length, 1);
    assert.equal(escalated[0].nodeId, 'gen');
});

test('verify: a distinct fingerprint does NOT grant a fresh budget (global attempt cap)', async () => {
    let calls = 0;
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{
            id: 'gen',
            execute: () => `out-${++calls}`,
            verify: /** @type {(out: any) => any} */ ((out) => ({ passed: false, evidence: `fail:${out}` })),
            terminal: true
        }],
        edges: []
    } });
    const seen = /** @type {any[]} */ ([]);
    sm.on('state_machine:verify_fail', (e) => seen.push(e.fingerprint));
    sm.on('state_machine:no_progress', (e) => seen.push(['stop', e.classification]));
    await assert.rejects(() => sm.run(), { message: /failed verification \(no_progress\)/ });
    assert.equal(seen.filter(x => typeof x === 'string').length, 3, 'three verification attempts then stop');
    assert.ok(new Set(seen.filter(x => typeof x === 'string')).size > 1, 'distinct fingerprints observed');
    assert.deepEqual(seen[seen.length - 1], ['stop', FailureClass.NO_PROGRESS]);
});

test('verify: no_progress and escalation events fire with the classification', async () => {
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{
            id: 'gen',
            execute: () => 'x',
            verify: () => ({ passed: false, evidence: 'boom' }),
            terminal: true
        }],
        edges: []
    }, options: { contract: { maxRetries: 2 } } });
    const events = /** @type {any[]} */ ([]);
    sm.on('state_machine:verify_fail', (e) => events.push(['fail', e.classification]));
    sm.on('state_machine:no_progress', (e) => events.push(['no_progress', e.classification]));
    await assert.rejects(() => sm.run(), { message: /failed verification/ });
    assert.deepEqual(events, [
        ['fail', FailureClass.VERIFICATION_FAILURE],
        ['fail', FailureClass.FAILED_HYPOTHESIS],
        ['fail', FailureClass.FAILED_HYPOTHESIS],
        ['no_progress', FailureClass.NO_PROGRESS]
    ]);
});

test('verify: a JS node without verify behaves as before (no retry machinery)', async () => {
    const sm = new StateMachine({ graph: {
        entry: 'a',
        nodes: [
            { id: 'a', execute: () => 'ok' },
            { id: 'done', execute: () => {}, terminal: true }
        ],
        edges: [{ from: 'a', to: 'done' }]
    } });
    await sm.run();
    assert.equal(sm.phase, 'done');
    assert.equal(sm.context.get({ k: 'a' }), 'ok');
});

// ─── Completion gate (criteria + judge) ─────────────────────────────────────

test('completion gate: all criteria pass → phase done + completed event', async () => {
    const sm = new StateMachine({ graph: {
        entry: 'a',
        nodes: [{ id: 'a', execute: () => ({ host: 'example.com' }), terminal: true }],
        edges: []
    }, options: {
        contract: /** @type {any} */ ({
            objective: 'parse host header',
            criteria: [{ name: 'host_present', check: /** @type {(ctx: any) => any} */ ((ctx) => ({ passed: !!ctx.get({ k: 'a' })?.host })) }]
        })
    } });
    let completed = /** @type {any} */ (null);
    sm.on('state_machine:completed', (e) => completed = e);
    await sm.run();
    assert.equal(sm.phase, 'done');
    assert.equal(completed.verified, true);
    assert.equal(completed.checks.length, 1);
});

test('completion gate: a failing criterion → phase failed, done not emitted', async () => {
    const sm = new StateMachine({ graph: {
        entry: 'a',
        nodes: [{ id: 'a', execute: () => ({}), terminal: true }],
        edges: []
    }, options: {
        contract: /** @type {any} */ ({
            objective: 'parse host header',
            criteria: [{ name: 'host_present', check: /** @type {(ctx: any) => any} */ ((ctx) => ({ passed: !!ctx.get({ k: 'a' })?.host })) }]
        })
    } });
    let failed = /** @type {any} */ (null);
    sm.on('state_machine:failed', (e) => failed = e);
    const ctx = await sm.run();
    assert.equal(sm.phase, 'failed');
    assert.ok(failed.reason.includes('host_present'));
    assert.deepEqual(ctx.getAll(), { a: {} });
});

test('completion gate: judge only runs when deterministic criteria pass', async () => {
    let judgeCalls = 0;
    const sm = new StateMachine({ graph: {
        entry: 'a',
        nodes: [{ id: 'a', execute: () => 'x', terminal: true }],
        edges: []
    }, options: {
        contract: {
            criteria: [{ name: 'always_fail', check: () => ({ passed: false, evidence: 'nope' }) }],
            judge: async () => { judgeCalls++; return { passed: true }; }
        }
    } });
    await sm.run();
    assert.equal(sm.phase, 'failed');
    assert.equal(judgeCalls, 0, 'judge skipped once a criterion fails');
});

test('completion gate: judge confirms when criteria pass', async () => {
    const sm = new StateMachine({ graph: {
        entry: 'a',
        nodes: [{ id: 'a', execute: () => 'x', terminal: true }],
        edges: []
    }, options: {
        contract: {
            criteria: [{ name: 'c1', check: () => ({ passed: true }) }],
            judge: async () => ({ passed: true, evidence: 'looks good' })
        }
    } });
    let completed = /** @type {any} */ (null);
    sm.on('state_machine:completed', (e) => completed = e);
    await sm.run();
    assert.equal(sm.phase, 'done');
    assert.equal(completed.checks[1].name, 'judge');
    assert.equal(completed.verified, true);
});

// ─── replan(): keeps context, re-plans graph ────────────────────────────────

test('replan: preserves context across the failed attempt', async () => {
    let plannedObjectives = /** @type {any[]} */ ([]);
    const fakeSession = {
        withSystemMessage() { return this; },
        withParameters() { return this; },
        provider: 'openai',
        /** @param {{initialInput: *}} arg0 */
        run: async ({ initialInput }) => {
            plannedObjectives.push(Array.isArray(initialInput) ? initialInput[initialInput.length - 1] : initialInput);
            return JSON.stringify({
                summary: 's', entry: 'n1',
                nodes: [{ id: 'n1', systemPrompt: 'do it', terminal: true }],
                edges: []
            });
        }
    };
    const fakeClient = { session: () => fakeSession };
    const sm = new StateMachine({ graph: { entry: '_', nodes: [{ id: '_', execute: () => {} }], edges: [] }, options: { client: fakeClient, defaultModel: 'm' } });
    await sm.run();
    sm.context.set({ k: 'kept', v: true });
    await sm.replan({ objective: 'Fix the parser', failedNodeId: 'old', reason: 'ValueError', evidence: 'not enough values' });
    assert.equal(sm.current, 'n1');
    assert.equal(sm.context.get({ k: 'kept' }), true, 'context survives replan');
    assert.ok(plannedObjectives.some(o => o.includes('failed at node "old"')));
});

// ─── Contract override via run() ────────────────────────────────────────────

test('run({ contract }) overrides the constructor contract', async () => {
    const sm = new StateMachine({ graph: {
        entry: 'a',
        nodes: [{ id: 'a', execute: () => 'x', terminal: true }],
        edges: []
    } });
    await sm.run({ contract: { criteria: [{ name: 'c', check: () => ({ passed: false }) }] } });
    assert.equal(sm.phase, 'failed');
});

// ─── Retry feedback (C1) / fallback reject (M1) / replan budget (M3) ─────────

/**
 * @param {{outputs: any}} arg0
 */
function makeLlmClient({ outputs }) {
    const prompts = /** @type {any[]} */ ([]);
    return {
        prompts,
        session() {
            return {
                provider: 'openai',
                withSystemMessage() { return this; },
                withTools() { return this; },
                /** @param {{initialInput: *}} arg0 */
                async run({ initialInput: messages }) {
                    // The prompt is the WHOLE input array, not row 0. A retry
                    // carries the failed attempt's rows before its new turn (A3),
                    // so a row-0 recorder would hide the feedback it is checking.
                    prompts.push(messages.map((/** @type {any} */ m) => String(m?.content ?? '')).join('\n'));
                    return outputs.length > 0 ? outputs.shift() : 'final';
                }
            };
        }
    };
}

test('verify: the retry prompt carries the failure evidence (not a context-blind re-run)', async () => {
    const client = makeLlmClient({ outputs: ['bad-output', 'bad-output', 'bad-output'] });
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{
            id: 'gen',
            model: 'm',
            userPromptTemplate: 'Produce the artifact.',
            verify: () => ({ passed: false, evidence: 'EVIDENCE-42' }),
            terminal: true
        }],
        edges: []
    }, options: { client, defaultModel: 'm' } });
    await assert.rejects(() => sm.run(), /failed verification/);
    assert.equal(client.prompts.length, 3, 'two automatic retries (default maxRetries 2)');
    assert.ok(client.prompts[1].includes('EVIDENCE-42'), 'the evidence reaches the retry prompt');
    assert.ok(client.prompts[1].includes('[Verification feedback'), 'retry is labeled as feedback');
    assert.equal(client.prompts[0].includes('EVIDENCE-42'), false, 'first attempt is not polluted with evidence');
});

const EMPTY_FALLBACK = FALLBACK_MESSAGE.EMPTY_RESPONSE;
const MAX_ITER_FALLBACK = 'The model reached the maximum tool iteration limit and could not provide a final text response.';

test('empty fallback is transient: retried within the attempt budget, then real output passes', async () => {
    const client = makeLlmClient({ outputs: [EMPTY_FALLBACK, 'real answer'] });
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{
            id: 'gen',
            model: 'm',
            userPromptTemplate: 'Produce the artifact.',
            terminal: true
        }],
        edges: []
    }, options: { client, defaultModel: 'm' } });
    const retried = /** @type {any[]} */ ([]);
    sm.on('state_machine:verify_retry', (e) => retried.push(e));
    await sm.run();
    assert.equal(sm.phase, 'done');
    assert.equal(sm.context.get({ k: 'gen' }), 'real answer', 'the transient empty never lands as node output');
    assert.equal(client.prompts.length, 2);
    assert.ok(client.prompts[1].includes('returned no text'), 'the retry is told its last run was empty');
    assert.equal(retried.length, 1, 'the empty retry fires the verify_retry event');
});

test('persistent empty fallback escalates after the attempt cap (not on the first one)', async () => {
    const client = makeLlmClient({ outputs: [EMPTY_FALLBACK, EMPTY_FALLBACK, EMPTY_FALLBACK] });
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{ id: 'gen', model: 'm', userPromptTemplate: 'Produce the artifact.', terminal: true }],
        edges: []
    }, options: { client, defaultModel: 'm' } });
    await assert.rejects(() => sm.run(), /SDK fallback/);
    assert.equal(client.prompts.length, 3, 'two transient retries (default maxRetries 2), then escalate');
    assert.equal(sm.context.get({ k: 'gen' }), undefined, 'the fallback must never be stored as node output');
});

test('max_iterations fallback stays terminal — a spent tool budget is not retried', async () => {
    const client = makeLlmClient({ outputs: [MAX_ITER_FALLBACK, 'never reached'] });
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{ id: 'gen', model: 'm', userPromptTemplate: 'Produce the artifact.', terminal: true }],
        edges: []
    }, options: { client, defaultModel: 'm' } });
    await assert.rejects(() => sm.run(), /SDK fallback/);
    assert.equal(client.prompts.length, 1, 'no retry — the iteration budget is spent');
});

test('replan: exceeds maxReplanCount fails loudly instead of looping forever', async () => {
    const fakeSession = {
        withSystemMessage() { return this; },
        withParameters() { return this; },
        provider: 'openai',
        run: async () => JSON.stringify({
            summary: 's', entry: 'n1',
            nodes: [{ id: 'n1', systemPrompt: 'do it', terminal: true }],
            edges: []
        })
    };
    const sm = new StateMachine({ graph: { entry: '_', nodes: [{ id: '_', execute: () => {} }], edges: [] }, options: { client: { session: () => fakeSession }, defaultModel: 'm', maxReplanCount: 1 } });
    await sm.replan({ objective: 'x' });
    await assert.rejects(() => sm.replan({ objective: 'x' }), /maxReplanCount \(1\)/);
    assert.equal(sm.phase, 'error');
});

test('verify failure clears the failed candidate from ctx before the retry (and after escalation)', async () => {
    /** @type {any[]} */
    const seenAtAttempt = [];
    /** @type {any[]} */
    const seenByVerify = [];
    const sm = new StateMachine({ graph: {
        entry: 'gen',
        nodes: [{
            id: 'gen',
            execute: (/** @type {any} */ ctx) => { seenAtAttempt.push(ctx.get({ k: 'gen' })); return 'unverified-artifact'; },
            verify: (/** @type {any} */ _out, /** @type {any} */ ctx) => { seenByVerify.push(ctx.get({ k: 'gen' })); return { passed: false, evidence: 'nope' }; },
            terminal: true
        }],
        edges: []
    }, options: { contract: { maxRetries: 2 } } });
    await assert.rejects(() => sm.run(), /failed verification/);
    assert.equal(seenAtAttempt.length, 3, 'the retry actually ran (maxRetries:2 → 3 attempts)');
    assert.deepEqual(seenAtAttempt, [undefined, undefined, undefined], 'a failed candidate is never visible to the retry');
    assert.deepEqual(seenByVerify, ['unverified-artifact', 'unverified-artifact', 'unverified-artifact'], 'verify still sees its own candidate');
    assert.equal(sm.context.get({ k: 'gen' }), undefined, 'a failed artifact must not linger in ctx');
    const payload = JSON.parse(sm.context.toPayloadString());
    assert.equal(Object.hasOwn(payload, 'gen'), false, 'the failed key is gone from the serialized context');
});
