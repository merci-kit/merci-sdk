// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { structuredLlmCall } from '../lib/agentic/planning/planner-utils.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: { ok: { type: 'boolean' } },
    required: ['ok']
};
const ARGS = { client: null, model: 'm', systemMessage: 's', schema: SCHEMA, prompt: 'do it' };

/**
 * @param {{run: (prompt: string) => any}} arg0
 */
function makeSessionObj({ run }) {
    const session = {
        provider: 'openai',
        withSystemMessage() { return session; },
        withTools() { return session; },
        withParameters() { return session; },
        /** @param {{initialInput: *}} arg0 */
        async run({ initialInput: prompt }) { return run(prompt); }
    };
    return session;
}

// ─── standard path: retry on prose-only response ────────────────────────────

test('structuredLlmCall: retries once when the first response has no JSON', async () => {
    let calls = 0;
    const client = {
        session: () => makeSessionObj({ run: () => {
            calls++;
            return calls === 1 ? 'I think we should just do it directly.' : '{"ok":true}';
        } })
    };
    const data = await structuredLlmCall({ ...ARGS, client });
    assert.deepEqual(data, { ok: true });
    assert.equal(calls, 2, 'one retry after the prose-only response');
});

test('structuredLlmCall: throws with the raw snippet after exhausting attempts', async () => {
    let calls = 0;
    const client = {
        session: () => makeSessionObj({ run: () => {
            calls++;
            return 'This plan needs no structured output. Just do the work.';
        } })
    };
    await assert.rejects(
        () => structuredLlmCall({ ...ARGS, client, maxAttempts: 3 }),
        { message: /Structured plan generation failed: Failed to parse or heal JSON structure/ }
    );
    assert.equal(calls, 3, 'three attempts before giving up');
    await assert.rejects(
        () => structuredLlmCall({ ...ARGS, client, maxAttempts: 3 }),
        { message: /Raw: This plan needs no structured output/ }
    );
});

// ─── OPENCODE branch: text fallback retries on prose ────────────────────────

test('structuredLlmCall: OPENCODE text fallback retries on prose', async () => {
    let n = 0;
    const session = {
        provider: ProviderType.OPENCODE,
        withSystemMessage() { return session; },
        withTools() { return session; },
        withParameters() { return session; },
        async *step() {
            n++;
            return { done: true, content: n === 1 ? 'no json here, sorry' : '{"ok":true}' };
        }
    };
    const client = { provider: ProviderType.OPENCODE, session: () => session };
    const data = await structuredLlmCall({ ...ARGS, client });
    assert.deepEqual(data, { ok: true });
    assert.equal(n, 2);
});

// ─── OPENCODE branch: in-turn self-heal on broken tool args ─────────────────

test('structuredLlmCall: OPENCODE feeds a parse error back so the model repairs args', async () => {
    /** @type {any} */
    let firstRoundFed = null;
    const session = {
        provider: ProviderType.OPENCODE,
        withSystemMessage() { return session; },
        withTools() { return session; },
        withParameters() { return session; },
        /**
         * @returns {AsyncGenerator<Record<string, any>, { done: boolean; content: string }, any>}
         */
        async *step() {
            firstRoundFed = yield { type: 'tool_request', calls: [{ name: 'plan', arguments: '{ broken args' }] };
            yield { type: 'tool_request', calls: [{ name: 'plan', arguments: '{"ok":true}' }] };
            return { done: true, content: 'ignored' };
        }
    };
    const client = { provider: ProviderType.OPENCODE, session: () => session };
    const data = await structuredLlmCall({ ...ARGS, client });
    assert.deepEqual(data, { ok: true });
    assert.ok(Array.isArray(firstRoundFed), 'first round received an error tool result, not null');
    assert.match(firstRoundFed[0]?.result, /VALIDATION_ERROR: Failed to parse or heal JSON structure/);
});
