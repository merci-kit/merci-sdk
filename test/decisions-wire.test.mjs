// @ts-check
/**
 * @file Decision wires — one canonical question/answer model, three adapters.
 * @version 0.23.0
 *
 * @description
 * The discriminative ("System One") models speak three different envelopes:
 * OpenAI's `input` + `questions[]`, the keyed `state` + `questions{}` of
 * OpenRouter / TypeSafe, and Gemini's `input` + `questions{}`. This test pins
 * the ONE canonical model those three project onto: request validation, the
 * per-wire body, and the per-wire answer normalization (a `noul` is
 * `probability` on OpenAI, `noul` elsewhere, and its confidence is optional).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildDecisionRequest,
    choiceQuestion,
    noulQuestion,
    scoreQuestion,
    readDecisionAnswer,
} from '../lib/messaging/decision.mjs';
import { createDecisionsClient } from '../lib/backends/decisions/index.mjs';
import { BackendError, ConfigurationError } from '../lib/core/errors.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { MerciClient as OaiClient } from '../lib/backends/oai.mjs';
import { MerciClient as GaiClient } from '../lib/backends/gai.mjs';

/**
 * A fetch that records the request and answers one canned JSON body.
 * @param {{body?: unknown, status?: number, headers?: Record<string, string>}} [arg0]
 * @returns {{fetch: typeof fetch, calls: Array<{url: string, headers: Headers, body: any}>}}
 */
function recorder({ body = {}, status = 200, headers = { 'content-type': 'application/json' } } = {}) {
    /** @type {Array<{url: string, headers: Headers, body: any}>} */
    const calls = [];
    const fetchImpl = async (/** @type {any} */ url, /** @type {any} */ init) => {
        calls.push({
            url: String(url),
            headers: new Headers(init?.headers),
            body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify(body), { status, headers });
    };
    return { fetch: /** @type {typeof fetch} */ (fetchImpl), calls };
}

const QUESTIONS = {
    refund: noulQuestion({
        instructions: 'Is the customer asking for money back?',
        criteria: { true: 'A refund is requested.', false: 'No refund is requested.' },
    }),
    team: choiceQuestion({
        instructions: 'Which team should own this ticket?',
        criteria: { billing: 'Charges and refunds.', account: 'Login and profile.' },
    }),
    urgency: scoreQuestion({
        instructions: 'How urgent is this ticket?',
        criteria: ['Can wait', 'This week', 'Right now'],
    }),
};

const REQUEST = { model: 'm', state: { ticket: 'Charged twice.' }, questions: QUESTIONS };

test('canonical: one request shape, validated at the trust boundary', () => {
    const request = buildDecisionRequest(REQUEST);
    assert.equal(request.model, 'm');
    assert.deepEqual(Object.keys(request.questions), ['refund', 'team', 'urgency']);
    assert.equal(request.questions.refund.type, 'noul');
    assert.equal(request.questions.team.type, 'choice');
    assert.equal(request.questions.urgency.type, 'score');
});

test('canonical: refuses the shapes every wire would refuse', () => {
    assert.throws(() => buildDecisionRequest({ ...REQUEST, model: '' }), ConfigurationError);
    assert.throws(() => buildDecisionRequest({ ...REQUEST, state: undefined }), ConfigurationError);
    assert.throws(() => buildDecisionRequest({ ...REQUEST, state: ['image-block'] }), ConfigurationError);
    assert.throws(() => buildDecisionRequest({ ...REQUEST, questions: {} }), ConfigurationError);
    assert.throws(() => buildDecisionRequest({ ...REQUEST, questions: { 'bad key': noulQuestion({ instructions: 'x' }) } }), ConfigurationError);
    assert.throws(() => buildDecisionRequest({ ...REQUEST, questions: { q: { type: 'nope', instructions: 'x' } } }), ConfigurationError);
    assert.throws(() => buildDecisionRequest({ ...REQUEST, questions: { q: choiceQuestion({ instructions: 'x', criteria: { only: '' } }) } }), ConfigurationError);
    assert.throws(() => buildDecisionRequest({ ...REQUEST, questions: { q: scoreQuestion({ instructions: 'x', criteria: ['only'] }) } }), ConfigurationError);
    assert.throws(() => buildDecisionRequest({ ...REQUEST, questions: { q: noulQuestion({}) } }), ConfigurationError);
});

test('canonical: a typed read, so a wrong or missing answer is an error not a default', () => {
    /** @type {Record<string, import('../lib/messaging/decision.mjs').DecisionAnswer>} */
    const answers = { refund: { type: 'noul', probability: 0.96, confidence: null } };
    assert.equal(readDecisionAnswer({ answers, name: 'refund', type: 'noul' }).probability, 0.96);
    assert.throws(() => readDecisionAnswer({ answers, name: 'missing' }), BackendError);
    assert.throws(() => readDecisionAnswer({ answers, name: 'refund', type: 'choice' }), BackendError);
});

test('openai: `input` + `questions[]`, `predicate`, array answers decoded back', async () => {
    const rec = recorder({
        body: {
            model: 'gpt-6-luna',
            answers: [
                { type: 'predicate', name: 'refund', probability: 0.91 },
                { type: 'choice', name: 'team', choice: 'billing', confidence: 0.8, probabilities: [{ value: 'billing', probability: 0.8 }, { value: 'account', probability: 0.2 }] },
                { type: 'score', name: 'urgency', score: 1.2, confidence: 0.7, probabilities: [{ value: 0, label: 'Can wait', probability: 0.2 }, { value: 1, label: 'This week', probability: 0.6 }, { value: 2, label: 'Right now', probability: 0.2 }] },
            ],
            usage: { input_tokens: 10, output_tokens: 0 },
        },
    });
    const client = createDecisionsClient({ provider: 'openai', apiKey: 'sk-test', fetchImpl: rec.fetch });

    const result = await client.ask({ ...REQUEST, model: 'gpt-6-luna' });

    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0]?.url, 'https://api.openai.com/v1/decisions');
    assert.equal(rec.calls[0]?.headers.get('authorization'), 'Bearer sk-test');
    assert.equal(rec.calls[0]?.body.model, 'gpt-6-luna');
    assert.equal(typeof rec.calls[0]?.body.input, 'string', 'structured state is serialized for the OpenAI wire');
    assert.equal(rec.calls[0]?.body.questions[0].type, 'predicate');
    assert.deepEqual(rec.calls[0]?.body.questions[1].choices, [
        { value: 'billing', description: 'Charges and refunds.' },
        { value: 'account', description: 'Login and profile.' },
    ]);
    assert.equal(rec.calls[0]?.body.questions[1].name, 'team');

    assert.deepEqual(result.answers.refund, { type: 'noul', probability: 0.91, confidence: null });
    assert.deepEqual(result.answers.team.probabilities, { billing: 0.8, account: 0.2 });
    assert.deepEqual(result.answers.urgency.legend, { '0': 'Can wait', '1': 'This week', '2': 'Right now' });
    assert.equal(result.answers.urgency.score, 1.2);
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 0, cost: null });
    assert.equal(result.model, 'gpt-6-luna');
});

test('openrouter: `state` + keyed `questions`, endpoint outside /api/v1', async () => {
    const rec = recorder({
        body: {
            id: 'gen-1',
            model: 'typesafe/jev-1.14',
            answers: {
                refund: { type: 'noul', noul: 0.87 },
                team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, account: 0.1 }, confidence: 0.8 },
                urgency: { type: 'score', score: 1.5, legend: { '0': 'Can wait', '1': 'This week', '2': 'Right now' }, probabilities: { '0': 0, '1': 0.5, '2': 0.5 }, confidence: 0.5 },
            },
            usage: { input_tokens: 40, output_tokens: 0, cost: 0.000002 },
        },
    });
    const client = createDecisionsClient({ provider: 'openrouter', apiKey: 'or-test', fetchImpl: rec.fetch });

    const result = await client.ask({ ...REQUEST, model: 'typesafe/jev-1.14' });

    assert.equal(rec.calls[0]?.url, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(rec.calls[0]?.headers.get('authorization'), 'Bearer or-test');
    assert.deepEqual(rec.calls[0]?.body.state, { ticket: 'Charged twice.' });
    assert.deepEqual(rec.calls[0]?.body.questions.refund.criteria, { true: 'A refund is requested.', false: 'No refund is requested.' });
    assert.equal(result.answers.refund.probability, 0.87);
    assert.equal(result.answers.refund.confidence, null, 'the keyed noul carries no confidence field');
    assert.equal(result.usage.cost, 0.000002);
});

test('gemini: `input` + keyed questions, google criteria names, api-key header', async () => {
    const rec = recorder({
        body: {
            answers: {
                refund: { type: 'noul', noul: 0.99, confidence: 0.99 },
                team: { type: 'choice', choice: 'account', probabilities: { billing: 0.01, account: 0.99 }, confidence: 0.99 },
                urgency: { type: 'score', score: 2, legend: { '0': 'Can wait', '1': 'This week', '2': 'Right now' }, probabilities: { '0': 0, '1': 0, '2': 1 }, confidence: 1 },
            },
            usage: { total_input_tokens: 100, total_output_tokens: 0, total_tokens: 100 },
        },
    });
    const client = createDecisionsClient({ provider: 'google_genai', apiKey: 'gem-test', fetchImpl: rec.fetch });

    const result = await client.ask({ ...REQUEST, model: 'gemini-decision-1' });

    assert.equal(rec.calls[0]?.url, 'https://generativelanguage.googleapis.com/v1beta/decisions');
    assert.equal(rec.calls[0]?.headers.get('x-goog-api-key'), 'gem-test');
    assert.equal(rec.calls[0]?.headers.get('authorization'), null);
    assert.deepEqual(rec.calls[0]?.body.questions.refund.criteria, {
        true_description: 'A refund is requested.',
        false_description: 'No refund is requested.',
    });
    assert.equal(result.answers.refund.confidence, 0.99);
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 0, cost: null });
});

test('client: `client.decisions` reuses the backend client credentials and emits lifecycle events', async () => {
    const rec = recorder({ body: { model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'refund', probability: 0.5 }], usage: { input_tokens: 1, output_tokens: 0 } } });
    const client = new OaiClient({ options: { provider: 'openai', apiKey: 'sk-test', transportOptions: { fetch: rec.fetch } } });
    /** @type {Array<string>} */
    const events = [];
    client.on(EVENTS.CLIENT.DECISIONS_START, () => events.push('start'));
    client.on(EVENTS.CLIENT.DECISIONS_FINISH, () => events.push('finish'));

    const result = await client.decisions.ask({ ...REQUEST, model: 'gpt-6-luna' });

    assert.deepEqual(events, ['start', 'finish']);
    assert.equal(rec.calls[0]?.url, 'https://api.openai.com/v1/decisions');
    assert.equal(result.answers.refund.type, 'noul');
});

test('client: an omitted model resolves from the provider descriptor env key', async () => {
    const rec = recorder({ body: { model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'ok', probability: 0.5 }] } });
    const saved = process.env.DEFAULT_OPENAI_DECISION_MODEL;
    process.env.DEFAULT_OPENAI_DECISION_MODEL = 'gpt-6-luna';
    try {
        const client = createDecisionsClient({ provider: 'openai', apiKey: 'k', fetchImpl: rec.fetch });
        const result = await client.ask({ state: 'x', questions: { ok: noulQuestion({ instructions: 'Is x true?' }) } });
        assert.equal(rec.calls[0]?.body.model, 'gpt-6-luna');
        assert.equal(result.model, 'gpt-6-luna');
    } finally {
        if (saved === undefined) delete process.env.DEFAULT_OPENAI_DECISION_MODEL;
        else process.env.DEFAULT_OPENAI_DECISION_MODEL = saved;
    }
});

test('client: an unconfigured decision model names the env key, not a silent default', async () => {
    const saved = process.env.DEFAULT_OPENAI_DECISION_MODEL;
    process.env.DEFAULT_OPENAI_DECISION_MODEL = '';
    try {
        const client = createDecisionsClient({ provider: 'openai', apiKey: 'k', fetchImpl: recorder().fetch });
        await assert.rejects(
            () => client.ask({ state: 'x', questions: { ok: noulQuestion({ instructions: 'Is x true?' }) } }),
            (error) => error instanceof ConfigurationError && /DEFAULT_OPENAI_DECISION_MODEL/.test(String(error.message)),
        );
    } finally {
        if (saved === undefined) delete process.env.DEFAULT_OPENAI_DECISION_MODEL;
        else process.env.DEFAULT_OPENAI_DECISION_MODEL = saved;
    }
});

test('keyed wire: a noul without criteria omits the key instead of sending null', async () => {
    const rec = recorder({ body: { answers: { spam: { type: 'noul', noul: 0.2 } } } });
    const client = createDecisionsClient({ provider: 'opencode', apiKey: 'k', fetchImpl: rec.fetch });
    await client.ask({ model: 'jev-1.13', state: 'buy now', questions: { spam: noulQuestion({ instructions: 'Is this spam?' }) } });
    assert.deepEqual(rec.calls[0]?.body.questions.spam, { type: 'noul', instructions: 'Is this spam?' });
});

test('opencode: Jev on the keyed wire, three documented roots map to one endpoint', async () => {
    const rec = recorder({
        body: {
            model: 'jev-1.13',
            answers: {
                refund: { type: 'noul', noul: 0.93 },
                team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.83, account: 0.17 }, confidence: 0.83 },
                urgency: { type: 'score', score: 2.1, legend: { '0': 'Can wait', '1': 'This week', '2': 'Right now' }, probabilities: { '0': 0, '1': 0.9, '2': 0.1 }, confidence: 0.9 },
            },
            usage: { input_tokens: 64, output_tokens: 0 },
        },
    });
    // The default chat base is the Go tier; Jev is sold on Zen.
    const client = new OaiClient({ options: { provider: 'opencode', apiKey: 'oc-test', transportOptions: { fetch: rec.fetch } } });

    const result = await client.decisions.ask({ ...REQUEST, model: 'jev-1.13' });

    assert.equal(rec.calls[0]?.url, 'https://opencode.ai/zen/v1/systemone');
    assert.equal(rec.calls[0]?.headers.get('authorization'), 'Bearer oc-test');
    assert.equal(rec.calls[0]?.headers.get('x-opencode-session'), null, 'the chat session header does not ride a decision call');
    assert.deepEqual(rec.calls[0]?.body.state, { ticket: 'Charged twice.' });
    assert.equal(rec.calls[0]?.body.questions.team.type, 'choice');
    assert.equal(result.answers.refund.probability, 0.93);
    assert.equal(result.model, 'jev-1.13');
});

test('opencode: a Console or Zen base keeps its own root', async () => {
    const zenRec = recorder({ body: { answers: { refund: { type: 'noul', noul: 0.5 } } } });
    const zenClient = createDecisionsClient({ provider: 'opencode', apiKey: 'k', baseURL: 'https://opencode.ai/zen/v1', fetchImpl: zenRec.fetch });
    await zenClient.ask({ ...REQUEST, model: 'jev-1.13' });
    assert.equal(zenRec.calls[0]?.url, 'https://opencode.ai/zen/v1/systemone');

    const consoleRec = recorder({ body: { answers: { refund: { type: 'noul', noul: 0.5 } } } });
    const consoleClient = createDecisionsClient({ provider: 'opencode', apiKey: 'k', baseURL: 'https://opencode.ai/inference/systemone/v1', fetchImpl: consoleRec.fetch });
    await consoleClient.ask({ ...REQUEST, model: 'jev-1.13' });
    assert.equal(consoleRec.calls[0]?.url, 'https://opencode.ai/inference/systemone/v1/systemone');
});

test('client: vertex names the Developer API as the decision path', async () => {
    const vertex = new GaiClient({ options: { apiKey: 'vertex-key', genaiOptions: { vertexai: true, project: 'p', location: 'global' } } });
    await assert.rejects(
        () => vertex.decisions.ask({ state: 'x', questions: { q: noulQuestion({ instructions: 'Is x true?' }) } }),
        (error) => error instanceof ConfigurationError && /Gemini Developer API/.test(String(error.message)),
    );
});

test('client: the Gemini backend exposes decisions, and an unsupported provider fails by name', async () => {
    const rec = recorder({ body: { answers: { refund: { type: 'noul', noul: 0.7 } }, usage: { total_input_tokens: 5, total_output_tokens: 0 } } });
    const gai = new GaiClient({ options: { apiKey: 'gem-test', transportOptions: { fetch: rec.fetch } } });
    const result = await gai.decisions.ask({ ...REQUEST, model: 'gemini-decision-1' });
    assert.equal(result.answers.refund.probability, 0.7);

    const local = new OaiClient({ options: { provider: 'local', apiKey: 'x' } });
    await assert.rejects(() => local.decisions.ask({ ...REQUEST, model: 'm' }), ConfigurationError);
});
