// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runEvals, EVAL_SCORERS } from '../lib/agentic/evals.mjs';
import { createCassette } from '../lib/support/cassette.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { NoRetryPolicy } from '../lib/support/retry-policy.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { FailureClass } from '../lib/agentic/loops/policy.mjs';

// 0.8.0 item I: an eval suite, scored, run offline against a cassette.

/**
 * A fake backend that answers from the last user turn: `weather <city>` calls
 * `forecast`, `json` answers a JSON object, anything else is echoed.
 * @param {{onCall?: () => void}} [arg0]
 */
function fakeAdapter({ onCall = () => {} } = {}) {
    return {
        vendorName: 'FAKE',
        buildVendorRequest: (/** @type {any} */ { preparedMessages }) => ({ request: { messages: preparedMessages.map((/** @type {any} */ { merciId, ...m }) => m) }, observability: {} }),
        executeVendorRequest: async (/** @type {any} */ { request }) => {
            onCall();
            const user = String(request.messages.find((/** @type {any} */ m) => m.role === 'user')?.content ?? '');
            const tool = request.messages.find((/** @type {any} */ m) => m.role === 'tool');
            if (user.startsWith('weather') && !tool) return [{ type: 'tool_calls', calls: [{ id: 'c1', name: 'forecast', args: {} }] }];
            if (tool) return [{ type: 'text', content: `It is ${tool.content}.` }, { type: 'quota', data: { prompt_tokens: 30, completion_tokens: 5 } }];
            if (user === 'json') return [{ type: 'text', content: '{"ok": true}' }];
            return [{ type: 'text', content: `echo: ${user}` }, { type: 'quota', data: { prompt_tokens: 10, completion_tokens: 2 } }];
        },
        consumeStream: (/** @type {any} */ { rawStream }) => (async function* () { yield* rawStream; })(),
        formatToolCall: (/** @type {any} */ { call }) => call,
    };
}

/** @param {{adapter: any, emitter?: EventEmitter}} arg0 */
function makeFakeSession({ adapter, emitter = new EventEmitter() }) {
    const session = /** @type {any} */ (new AbstractChatSession({ provider: ProviderType.OPENAI, model: 'm', eventEmitter: emitter, client: /** @type {any} */ ({ session() {} }), retryPolicy: new NoRetryPolicy() }));
    session._streamTimeoutPolicy = {};
    session._adapter = adapter;
    session.withTools({ tools: [{ name: 'forecast', description: 'f', parameters: { type: 'object', properties: {} }, execute: async () => 'sunny' }] });
    return session;
}

const CASES = [
    { name: 'weather', input: 'weather Prague', expected: { output: /sunny/, tools: ['forecast'], toolSequence: ['forecast'], maxTotalTokens: 100 } },
    { name: 'echo', input: 'hello', expected: { output: 'echo: hello', toolSequence: [], maxTotalTokens: 100 } },
    { name: 'json', input: 'json', expected: { schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] } } },
    { name: 'wrong', input: 'bye', expected: { output: 'echo: hello' } },
];

test('I: a suite scores every case; recorded once, it replays offline with the same verdicts', async () => {
    const cassette = createCassette();
    const scorers = [EVAL_SCORERS.outputMatches(), EVAL_SCORERS.outputSchema(), EVAL_SCORERS.toolsCalled(), EVAL_SCORERS.toolSequence(), EVAL_SCORERS.withinBudget()];
    let liveCalls = 0;
    const recorded = await runEvals({
        cases: CASES, scorers, concurrency: 2,
        makeSession: () => makeFakeSession({ adapter: fakeAdapter({ onCall: () => { liveCalls += 1; } }) }).withCassette({ cassette, mode: 'record' }),
    });
    assert.equal(liveCalls, 5, 'the weather case calls twice, the others once');
    assert.deepEqual(recorded.results.map((r) => [r.name, r.passed]), [['weather', true], ['echo', true], ['json', true], ['wrong', false]]);
    assert.equal(recorded.passRate, 0.75);
    const weather = recorded.results[0];
    assert.deepEqual(weather.observation.toolCalls, [{ name: 'forecast', success: true }], 'tool calls come from tool:call_end');
    assert.equal(weather.observation.usage?.total_tokens, 35, 'usage comes from run:end');
    assert.ok(weather.verdicts.find((v) => v.name === 'outputSchema')?.skipped, 'a missing expectation is skipped, not failed');
    assert.match(String(recorded.results[3].verdicts.find((v) => v.name === 'outputMatches')?.evidence), /expected echo: hello/);

    const replayed = await runEvals({
        cases: CASES, scorers,
        makeSession: () => makeFakeSession({ adapter: fakeAdapter({ onCall: () => { throw new Error('the vendor was called'); } }) }).withCassette({ cassette, mode: 'replay' }),
    });
    assert.deepEqual(replayed.results.map((r) => r.verdicts.map((v) => v.passed)), recorded.results.map((r) => r.verdicts.map((v) => v.passed)));
    assert.equal(replayed.passRate, 0.75);
});

test('I: a run that throws fails its case with a FailureClass; a judge and a throwing scorer are verdicts too', async () => {
    const cassette = createCassette();
    /** @type {any[]} */
    const judged = [];
    const scoredJudge = Object.assign(async (/** @type {any} */ { ctx }) => { judged.push(ctx.getAll()); return { score: ctx.getAll().output?.includes('hello') ? 0.9 : 0.1 }; }, { scoreField: 'score' });
    const { results, passRate } = await runEvals({
        cases: [{ name: 'ok', input: 'hello' }, { name: 'unrecorded', input: 'never recorded' }],
        makeSession: ({ index }) => makeFakeSession({ adapter: fakeAdapter() }).withCassette({ cassette, mode: index === 0 ? 'record' : 'replay' }),
        scorers: [
            EVAL_SCORERS.judge({ judge: scoredJudge, threshold: 0.5 }),
            EVAL_SCORERS.judge({ judge: async () => ({ passed: true, evidence: 'fine' }), name: 'pass-judge' }),
            Object.defineProperty(() => { throw new Error('scorer bug'); }, 'name', { value: 'buggy' }),
        ],
    });
    assert.equal(passRate, 0);
    const [ok, unrecorded] = results;
    assert.equal(ok.verdicts[0].score, 0.9);
    assert.equal(ok.verdicts[0].passed, true);
    assert.equal(ok.verdicts[1].passed, true);
    assert.deepEqual([ok.verdicts[2].name, ok.verdicts[2].passed], ['buggy', false], 'a throwing scorer fails the case, it does not crash the suite');
    assert.match(String(ok.verdicts[2].evidence), /scorer bug/);
    assert.equal(judged[0].output, 'echo: hello', 'the judge sees the run');
    assert.equal(unrecorded.passed, false);
    assert.equal(unrecorded.observation.output, null);
    assert.match(String(unrecorded.observation.error?.message), /no recording/);
    assert.equal(unrecorded.observation.failureClass, FailureClass.ENVIRONMENT_MISMATCH);
});

test('I: concurrency bounds the cases in flight; bad arguments are refused', async () => {
    let inFlight = 0;
    let peak = 0;
    await runEvals({
        cases: Array.from({ length: 6 }, (_, i) => ({ input: `c${i}` })),
        concurrency: 2,
        makeSession: () => ({ run: async () => { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight -= 1; return 'x'; } }),
    });
    assert.equal(peak, 2);
    await assert.rejects(() => runEvals({ cases: /** @type {any} */ (null), makeSession: () => ({ run: async () => '' }) }), /cases/);
    await assert.rejects(() => runEvals({ cases: [], makeSession: /** @type {any} */ (null) }), /makeSession/);
    assert.deepEqual(await runEvals({ cases: [], makeSession: () => ({ run: async () => '' }) }), { results: [], passRate: 0 });
});

test('I review: concurrent cases on one shared emitter see only their own tool calls and usage', async () => {
    const shared = new EventEmitter();
    const { results } = await runEvals({
        cases: [{ input: 'weather Oslo', expected: { toolSequence: ['forecast'] } }, { input: 'weather Rome', expected: { toolSequence: ['forecast'] } }],
        concurrency: 2,
        scorers: [EVAL_SCORERS.toolSequence()],
        makeSession: () => makeFakeSession({ adapter: fakeAdapter(), emitter: shared }),
    });
    assert.deepEqual(results.map((r) => r.observation.toolCalls.length), [1, 1], 'not each other\'s');
    assert.deepEqual(results.map((r) => r.observation.usage?.total_tokens), [35, 35]);
    assert.equal(results.every((r) => r.passed), true);
});

test('I review: unknown usage fails a token budget; a /g pattern matches on every run', async () => {
    const flagged = { input: 'x', expected: { output: /ok/g, maxTotalTokens: 10 } };
    const noEmitter = () => ({ run: async () => 'ok ok' });
    const first = await runEvals({ cases: [flagged], makeSession: noEmitter, scorers: [EVAL_SCORERS.outputMatches(), EVAL_SCORERS.withinBudget()] });
    const second = await runEvals({ cases: [flagged], makeSession: noEmitter, scorers: [EVAL_SCORERS.outputMatches()] });
    assert.equal(first.results[0].verdicts[0].passed, true);
    assert.equal(second.results[0].verdicts[0].passed, true, 'the same case object, a second run');
    assert.equal(first.results[0].verdicts[1].passed, false);
    assert.match(String(first.results[0].verdicts[1].evidence), /usage unknown/);
});
