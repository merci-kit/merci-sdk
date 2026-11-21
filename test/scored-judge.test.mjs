// @ts-check

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { createLlmJudge, createScoredJudge } from '../lib/agentic/loops/judge.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: { score: { type: 'number' }, reason: { type: 'string' } },
    required: ['score', 'reason']
};

/**
 * @param {{payloads: string[]}} arg0
 */
function makeClient({ payloads }) {
    let i = 0;
    const pick = () => payloads[Math.min(i++, payloads.length - 1)];
    const session = {
        provider: 'openai',
        withSystemMessage() { return session; },
        withTools() { return session; },
        withParameters() { return session; },
        async run() { return pick(); }
    };
    return { session: () => session };
}

const ctx = { getAll: () => ({ objective: 'ship it' }) };

test('createScoredJudge returns the schema-shaped score object', async () => {
    const judge = createScoredJudge({
        client: makeClient({ payloads: ['{"score":0.75,"reason":"good"}'] }),
        model: 'm',
        schema: SCHEMA
    });
    assert.deepEqual(await judge({ ctx }), { score: 0.75, reason: 'good' });
});

test('a non-conforming response is rejected, not silently accepted', async () => {
    const judge = createScoredJudge({
        client: makeClient({ payloads: ['{"score":"high"}'] }),
        model: 'm',
        schema: SCHEMA
    });
    await assert.rejects(() => judge({ ctx }), /Failed to parse or heal|Schema Validation Failed/);
});

test('default aggregate averages the score field, order-independent', async () => {
    const judge = createScoredJudge({
        client: makeClient({ payloads: ['{"score":1,"reason":"a"}'] }),
        model: 'm',
        schema: SCHEMA
    });
    const scores = [
        { score: 1, reason: 'a' },
        { score: 0.5, reason: 'b' },
        { score: 0, reason: 'c' }
    ];
    assert.equal((/** @type {any} */ (judge)).aggregate(scores), 0.5);
    assert.equal((/** @type {any} */ (judge)).aggregate([...scores].reverse()), 0.5);
});

test('a custom aggregate overrides the default reducer', async () => {
    const judge = createScoredJudge({
        client: makeClient({ payloads: ['{"score":1,"reason":"a"}'] }),
        model: 'm',
        schema: SCHEMA,
        /** @param {{scores: *}} arg0 */
        aggregate: ({ scores }) => scores.length
    });
    assert.equal((/** @type {any} */ (judge)).aggregate([{ score: 1 }, { score: 1 }]), 2);
});

test('createScoredJudge requires a schema', () => {
    assert.throws(
        () => createScoredJudge(/** @type {any} */ ({ client: makeClient({ payloads: ['{}'] }), model: 'm' })),
        ConfigurationError
    );
});

test('createLlmJudge is untouched — still returns {passed, evidence}', async () => {
    const judge = createLlmJudge({
        client: makeClient({ payloads: ['{"passed":true,"evidence":"ok"}'] }),
        model: 'm'
    });
    assert.deepEqual(await judge({ ctx }), { passed: true, evidence: 'ok' });
});
