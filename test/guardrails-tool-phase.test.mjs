// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createGuardrails } from '../lib/agentic/guardrails.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { createHooks, HOOKS, STOP as STOP_TOKEN } from '../lib/core/hooks.mjs';
import { NoRetryPolicy } from '../lib/support/retry-policy.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';

// 0.8.0 item K: predicate rules and the tool phases.

test('K: a predicate rule trips on true — sync or async — and a throwing predicate refuses', async () => {
    const guardrails = createGuardrails({ rules: [
        { name: 'sync', phase: 'input', test: (text) => text.includes('forbidden') },
        { name: 'async', phase: 'output', test: async (text) => text.length > 10 },
    ] });
    assert.equal((await guardrails.check({ phase: 'input', text: 'a forbidden word' })).rule?.name, 'sync');
    assert.equal((await guardrails.check({ phase: 'input', text: 'fine' })).blocked, false);
    assert.equal((await guardrails.check({ phase: 'output', text: 'a long enough answer' })).rule?.name, 'async');
    const broken = createGuardrails({ rules: [{ phase: 'input', test: () => { throw new Error('moderation down'); } }] });
    await assert.rejects(() => broken.check({ phase: 'input', text: 'x' }), /moderation down/);
});

test('K: `both` still means input and output only; a tool rule watches only its tool phase', async () => {
    const guardrails = createGuardrails({ rules: [{ name: 'b', pattern: 'x' }, { name: 't', phase: 'tool_input', pattern: 'y' }] });
    assert.equal((await guardrails.check({ phase: 'tool_input', text: 'x' })).rule, null);
    assert.equal((await guardrails.check({ phase: 'input', text: 'y' })).rule, null);
    assert.equal((await guardrails.check({ phase: 'tool_input', text: 'y' })).rule?.name, 't');
    assert.equal(createGuardrails({ rules: [{ pattern: 'x' }] }).hooks, null, 'no tool rule, no tool hooks');
});

/**
 * A session whose model calls `write_file` once, then answers with the tool result it saw.
 * @param {{rules: any[], hooks?: any}} arg0
 */
function toolSession({ rules, hooks }) {
    /** @type {any[]} */
    const executed = [];
    /** @type {any[]} */
    const tripped = [];
    let call = 0;
    const session = /** @type {any} */ (new AbstractChatSession({ provider: ProviderType.OPENAI, model: 'm', eventEmitter: new EventEmitter(), client: /** @type {any} */ ({ session() {} }), retryPolicy: new NoRetryPolicy() }));
    session._streamTimeoutPolicy = {};
    session._adapter = {
        vendorName: 'FAKE',
        buildVendorRequest: (/** @type {any} */ { preparedMessages }) => ({ request: { preparedMessages }, observability: {} }),
        executeVendorRequest: async (/** @type {any} */ { request }) => {
            call += 1;
            const round = call;
            const lastTool = [...request.preparedMessages].reverse().find((/** @type {any} */ m) => m.role === 'tool');
            return (async function* () {
                if (round === 1) yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'write_file', args: { path: '/etc/passwd', text: 'SECRET-OUT' } }] };
                else yield { type: 'text', content: `saw: ${String(lastTool?.content ?? '')}` };
            })();
        },
        consumeStream: (/** @type {any} */ { rawStream }) => rawStream,
        formatToolCall: (/** @type {any} */ { call: c }) => c,
    };
    session.withTools({ tools: [{ name: 'write_file', description: 'w', parameters: { type: 'object', properties: {} }, execute: async (/** @type {any} */ { args }) => { executed.push(args); return `wrote ${args.text}`; } }] });
    session.withGuardrails({ rules });
    if (hooks) session.withHooks({ hooks });
    session.eventEmitter.on(EVENTS.GUARDRAIL.TRIPPED, (/** @type {any} */ e) => tripped.push(e));
    return { session, executed, tripped };
}

test('K: a blocking tool_input rule stops the tool before it runs', async () => {
    const { session, executed, tripped } = toolSession({ rules: [{ name: 'no-etc', phase: 'tool_input', pattern: '/etc/' }] });
    const out = await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] });
    assert.deepEqual(executed, [], 'the tool never ran');
    assert.match(out, /blocked/, 'the model saw a refusal, not a result');
    assert.equal(tripped.length, 1);
    assert.equal(tripped[0].phase, 'tool_input');
    assert.equal(tripped[0].tool, 'write_file');
    assert.equal(tripped[0].blocked, true);
});

test('K: a blocking tool_output rule withholds the result from the model; warn lets it through', async () => {
    const blocked = toolSession({ rules: [{ name: 'no-secret-out', phase: 'tool_output', pattern: 'SECRET-OUT' }] });
    const out = await runAgenticLoop({ session: blocked.session, messages: [{ role: 'user', content: 'go' }] });
    assert.equal(blocked.executed.length, 1, 'the tool ran');
    assert.doesNotMatch(out, /wrote SECRET-OUT/, 'its result never reached the model');
    assert.match(out, /no-secret-out/);

    const warned = toolSession({ rules: [{ name: 'note', phase: 'tool_output', pattern: 'SECRET-OUT', action: 'warn' }] });
    const seen = await runAgenticLoop({ session: warned.session, messages: [{ role: 'user', content: 'go' }] });
    assert.match(seen, /wrote SECRET-OUT/);
    assert.equal(warned.tripped[0]?.blocked, false);
});

test('K: the guardrail runs after the session hooks — it judges the arguments they settled on', async () => {
    const hooks = createHooks();
    hooks.add({ name: HOOKS.TOOL_BEFORE, fn: async (/** @type {any} */ v) => ({ ...v, args: { ...v.args, path: '/tmp/safe' } }) });
    const { session, executed } = toolSession({ rules: [{ name: 'no-etc', phase: 'tool_input', pattern: '/etc/' }], hooks });
    await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] });
    assert.equal(executed.length, 1, 'the hook rewrote the path, so the rule let the call through');
    assert.equal(executed[0].path, '/tmp/safe');
    assert.equal(hooks.count({ name: HOOKS.TOOL_BEFORE }), 1, 'the session registry was not mutated');
});

test('K review: a session hook cannot slip a call past the guard — tool:after STOP, or a tool:before value without args', async () => {
    const after = createHooks();
    after.add({ name: HOOKS.TOOL_AFTER, fn: async () => STOP_TOKEN });
    const kept = toolSession({ rules: [{ name: 'no-secret-out', phase: 'tool_output', pattern: 'SECRET-OUT' }], hooks: after });
    const out = await runAgenticLoop({ session: kept.session, messages: [{ role: 'user', content: 'go' }] });
    assert.doesNotMatch(out, /wrote SECRET-OUT/, 'STOP keeps the output, and the guard still judges it');

    const before = createHooks();
    before.add({ name: HOOKS.TOOL_BEFORE, fn: async () => ({ note: 'audited' }) });
    const blocked = toolSession({ rules: [{ name: 'no-etc', phase: 'tool_input', pattern: '/etc/' }], hooks: before });
    await runAgenticLoop({ session: blocked.session, messages: [{ role: 'user', content: 'go' }] });
    assert.deepEqual(blocked.executed, [], 'the call still runs with /etc/passwd, so the guard judges that');
});

test('K review: a truthy predicate result trips the rule', async () => {
    const guardrails = createGuardrails({ rules: [{ name: 'match', phase: 'input', test: (text) => text.match(/secret/) }] });
    assert.equal((await guardrails.check({ phase: 'input', text: 'a secret' })).blocked, true);
    assert.equal((await guardrails.check({ phase: 'input', text: 'fine' })).blocked, false);
});
