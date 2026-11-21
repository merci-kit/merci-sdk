// @ts-check
/**
 * A structured utility call (planner / replanner / evaluator) must not wait
 * forever on a provider stream that keeps producing text without ever
 * finishing. The stream inactivity timeout cannot catch that — every chunk
 * resets it — so the call needs a total deadline of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { structuredLlmCall } from '../lib/agentic/planning/planner-utils.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: { ok: { type: 'boolean' } },
    required: ['ok']
};
const ARGS = { model: 'm', systemMessage: 's', schema: SCHEMA, prompt: 'do it' };

/**
 * A vendor stream that keeps yielding text for `totalMs` and only then ends —
 * the shape of a model stuck repeating itself (each chunk resets the
 * inactivity timer, so only a total deadline can stop it).
 * @param {{totalMs: number}} arg0
 */
function makeChattyAdapter({ totalMs }) {
    return {
        vendorName: 'STUB',
        /** @param {{model?: any}} p */
        buildVendorRequest({ model }) { return { request: { model }, observability: { model } }; },
        executeVendorRequest() {
            return (async function* () {
                const until = Date.now() + totalMs;
                while (Date.now() < until) {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    yield { text: 'again and again. ' };
                }
            })();
        },
        /** @param {{rawStream: any}} arg0 */
        consumeStream({ rawStream }) {
            return (async function* () {
                for await (const chunk of rawStream) {
                    if (chunk && typeof chunk.text === 'string') yield { type: 'text', content: chunk.text };
                }
            })();
        },
        extractXmlToolCalls() { return []; },
        /** @param {{call: any}} arg0 */
        formatToolCall({ call }) { return { id: call.id, name: call.name, args: call.args }; },
    };
}

class ChattySession extends AbstractChatSession {
    /** @param {{totalMs: number}} arg0 */
    constructor({ totalMs }) {
        super({ provider: ProviderType.OPENAI, model: 'gpt-4o-mini', eventEmitter: new EventEmitter(), client: null, vendorClient: {} });
        this._adapter = makeChattyAdapter({ totalMs });
        /** @type {any} */ (this)._retryPolicy = null;
    }

    /** The parameter builder is backend wiring; this stub has no wire format. */
    withParameters() { return this; }
}

test('structuredLlmCall: a never-ending provider stream is cut by the call deadline', async () => {
    const session = new ChattySession({ totalMs: 10_000 });
    const client = { provider: ProviderType.OPENAI, session: () => session };

    const started = Date.now();
    await assert.rejects(
        () => structuredLlmCall({ ...ARGS, client, timeoutMs: 60, maxAttempts: 1 }),
        /deadline|timeout|abort/i,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `gave up on the degenerate stream promptly (took ${elapsed}ms, not the adapter's 10000ms)`);
});

test('structuredLlmCall: a deadline hit retries on a fresh session and succeeds', async () => {
    let created = 0;
    const client = {
        provider: ProviderType.OPENAI,
        session: () => {
            created += 1;
            if (created === 1) return new ChattySession({ totalMs: 10_000 });
            return {
                provider: ProviderType.OPENAI,
                withSystemMessage() { return this; },
                withParameters() { return this; },
                async run() { return '{"ok":true}'; },
            };
        },
    };

    const started = Date.now();
    const data = await structuredLlmCall({ ...ARGS, client, timeoutMs: 60, maxAttempts: 2 });
    const elapsed = Date.now() - started;
    assert.deepEqual(data, { ok: true });
    assert.equal(created, 2, 'the retry used a fresh session');
    assert.ok(elapsed < 3000, `recovered promptly (took ${elapsed}ms)`);
});

test('structuredLlmCall: reports the call usage to onUsage', async () => {
    const session = {
        provider: ProviderType.OPENAI,
        withSystemMessage() { return this; },
        withParameters() { return this; },
        withTimeout() { return this; },
        /** @param {{options?: any}} arg0 */
        async run({ options }) {
            options?.onEvent?.({ type: 'quota', data: { prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.01 } });
            return '{"ok":true}';
        },
    };
    const client = { provider: ProviderType.OPENAI, session: () => session };
    /** @type {any} */
    let seen = null;
    const data = await structuredLlmCall({ ...ARGS, client, maxAttempts: 1, onUsage: (/** @type {any} */ usage) => { seen = usage; } });
    assert.deepEqual(data, { ok: true });
    assert.deepEqual(seen, { prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.01 });
});
