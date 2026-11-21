// @ts-check

/**
 * Wave 2 — the agentic capabilities that live in the SDK core: USD cost
 * accounting, guardrails, permission rules, streaming input, per-tool
 * timeouts, tool-output validation, output capping and the `request:after`
 * hook.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { BaseChatSession } from '../lib/agentic/chat-session.mjs';
import { executeTools } from '../lib/tools/tool-execution.mjs';
import { BudgetExceededError, ConfigurationError, GuardrailViolationError } from '../lib/core/errors.mjs';
import { EVENTS, RunContext } from '../lib/core/events.mjs';
import { ERROR_CODES, ProviderType } from '../lib/core/constants/index.mjs';
import { createHooks } from '../lib/core/hooks.mjs';

/**
 * A minimal session that answers one step with the given usage.
 * @param {{ usage?: Record<string, any>, content?: string, model?: string }} arg0
 * @returns {any}
 */
function fakeSession({ usage = { prompt_tokens: 10, completion_tokens: 5 }, content = 'hi', model = 'gpt-4o' } = {}) {
    const emitter = new EventEmitter();
    return {
        provider: ProviderType.OPENAI,
        model,
        _tools: [],
        eventEmitter: emitter,
        emitter,
        /**
         * @param {{messages: any}} arg0
         */
        async *step({ messages }) {
            yield { type: 'quota', data: usage };
            return { done: true, content, messages: [...messages, { role: 'assistant', content }] };
        }
    };
}

/**
 * An approval callback that records the tools it was asked about.
 * @param {{asked: string[]}} arg0
 * @returns {(name: string) => Promise<boolean>}
 */
function approvalAsker({ asked }) {
    return async (name) => { asked.push(name); return true; };
}

/**
 * A real session over a stub vendor adapter — the request:after hook lives in
 * the session's own step, so it needs a real step.
 * @returns {any}
 */
function stubSession() {
    const adapter = {
        vendorName: 'STUB',
        buildVendorRequest: () => ({ request: { marker: 'original' }, observability: { model: 'm' } }),
        executeVendorRequest: () => ({}),
        consumeStream: async function* () { yield { type: 'text', content: 'hi' }; },
        extractXmlToolCalls: () => [],
        formatToolCall: (/** @type {any} */ { call }) => ({ id: call.id, name: call.name, args: {} })
    };
    return new (class extends BaseChatSession {})({
        vendorClient: {},
        model: 'm',
        eventEmitter: new EventEmitter(),
        provider: ProviderType.OPENAI,
        adapter,
        buildParameters: (/** @type {any} */ { s }) => s
    });
}

// ── W2.1 / W3.1 USD cost accounting — the BACKEND's own amount ──────────────
// Wave 3 removed the static price table: the SDK never estimates a price. The
// money budget follows the cost the backend reports with its usage, and the
// token budget is the budget mechanism.

test('W2.1: the usage snapshot carries the cost the backend reported', async () => {
    const session = fakeSession({ usage: { prompt_tokens: 100, completion_tokens: 10, cost_usd: 0.25 } });
    /** @type {any[]} */
    const ends = [];
    session.emitter.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => ends.push(e));
    await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] });
    assert.equal(ends.length, 1);
    assert.equal(ends[0].usage.cost_usd, 0.25, 'the reported cost is carried through');
});

test('W2.1: without a reported cost the cost is unknown, never zero', async () => {
    const session = fakeSession({ usage: { prompt_tokens: 100, completion_tokens: 10 } });
    /** @type {any[]} */
    const ends = [];
    session.emitter.on(EVENTS.CLIENT.RUN_END, (/** @type {any} */ e) => ends.push(e));
    await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] });
    assert.equal(ends[0].usage.cost_usd, null, 'an unreported cost is unknown, not zero');
});

test('W2.1: a USD budget stops the run when the backend reports the cost', async () => {
    const session = fakeSession({ usage: { prompt_tokens: 100, completion_tokens: 10, cost_usd: 5 } });
    session._budget = { maxBudgetUsd: 1 };
    await assert.rejects(
        () => runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] }),
        (err) => {
            assert.ok(err instanceof BudgetExceededError, 'the typed budget error is thrown');
            assert.match(err.message, /USD budget exceeded/);
            return true;
        }
    );
});

test('W2.1: a USD budget the backend cannot report is announced, not fatal', async () => {
    const session = fakeSession({ usage: { prompt_tokens: 100, completion_tokens: 10 } });
    session._budget = { maxBudgetUsd: 1 };
    /** @type {any[]} */
    const notices = [];
    session.emitter.on(EVENTS.CLIENT.BUDGET_UNREPORTED, (/** @type {any} */ e) => notices.push(e));
    const out = await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] });
    assert.equal(out, 'hi', 'the run continues — the token budget is the mechanism');
    assert.equal(notices.length, 1, 'the unenforceable budget is announced once');
});

test('W2.1: the token budget is enforced on its own', async () => {
    const session = fakeSession({ usage: { prompt_tokens: 1000, completion_tokens: 10 } });
    session._budget = { maxTotalTokens: 100 };
    await assert.rejects(
        () => runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] }),
        /Token budget exceeded/
    );
});

test('W2.1: withBudget accepts a USD cap next to the token cap', () => {
    const builder = new ChatSessionBuilder();
    assert.deepEqual(builder.withBudget({ budget: { maxBudgetUsd: 2 } })._budget, { maxBudgetUsd: 2 });
    assert.deepEqual(builder.withBudget({ budget: { maxTotalTokens: 5, maxBudgetUsd: 2 } })._budget, { maxTotalTokens: 5, maxBudgetUsd: 2 });
    assert.equal(builder.withBudget({ budget: { maxBudgetUsd: -1 } })._budget, null);
});

// ── W2.8 per-tool timeout ────────────────────────────────────────────────────

test('W2.8: a tool that outlives its timeout does not stall the round', async () => {
    const results = /** @type {any[]} */ (await executeTools({
        toolCalls: [{ id: 'c1', name: 'slow', arguments: '{}' }],
        toolLibrary: [{
            name: 'slow',
            description: 'never finishes',
            parameters: { type: 'object', properties: {} },
            timeoutMs: 60,
            execute: () => new Promise(() => { /* hangs forever */ })
        }],
        toolTimeoutMs: null
    }));
    assert.equal(results[0].success, false);
    assert.match(results[0].error, /exceeded its 60ms timeout/);
});

test('W2.8: the per-tool timeout fires even when the tool is the only pending work', () => {
    // The timeout timer is the mechanism that unblocks the round, so it must
    // keep the process alive while the tool is pending. With an unref'd timer
    // the event loop empties and node kills the run with exit 13 ("unsettled
    // top-level await") before the timeout can report anything.
    const moduleUrl = new URL('../lib/tools/tool-execution.mjs', import.meta.url).href;
    const script = `
import { executeTools } from ${JSON.stringify(moduleUrl)};
const results = await executeTools({
    toolCalls: [{ id: 'c1', name: 'hang', arguments: '{}' }],
    toolLibrary: [{ name: 'hang', description: 'never returns', parameters: { type: 'object', properties: {} }, execute: () => new Promise(() => {}) }],
    toolTimeoutMs: 50,
});
process.stdout.write(String(results[0].error));
`;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(out.status, 0, `the round must unblock (stderr: ${out.stderr})`);
    assert.match(out.stdout, /exceeded its 50ms timeout/);
});

test('W2.8: an aborted round does not keep the process alive for the whole timeout', () => {
    // The timeout timer holds the process while the tool is pending — so it
    // must be released when the round is aborted, or an aborted run would
    // linger for the whole timeout.
    const moduleUrl = new URL('../lib/tools/tool-execution.mjs', import.meta.url).href;
    const script = `
import { executeTools } from ${JSON.stringify(moduleUrl)};
const controller = new AbortController();
setTimeout(() => controller.abort(), 100);
try {
    await executeTools({
        toolCalls: [{ id: 'c1', name: 'hang', arguments: '{}' }],
        toolLibrary: [{ name: 'hang', description: 'never returns', parameters: { type: 'object', properties: {} }, execute: () => new Promise(() => {}) }],
        toolTimeoutMs: 5000,
        signal: controller.signal
    });
} catch (err) {
    process.stdout.write('aborted: ' + String(err && err.message));
}
`;
    const started = Date.now();
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
    const elapsed = Date.now() - started;
    assert.equal(out.status, 0, `the aborted round must end the process (stderr: ${out.stderr})`);
    assert.match(out.stdout, /aborted: Tool execution aborted/);
    assert.equal(elapsed < 3000, true, `the process must not linger for the 5s timeout (took ${elapsed}ms)`);
});

test('W2.8: the round-wide timeout applies to a tool without its own', async () => {
    const results = /** @type {any[]} */ (await executeTools({
        toolCalls: [{ id: 'c1', name: 'slow', arguments: '{}' }],
        toolLibrary: [{
            name: 'slow',
            description: 'never finishes',
            parameters: { type: 'object', properties: {} },
            execute: () => new Promise(() => { /* hangs forever */ })
        }],
        toolTimeoutMs: 60
    }));
    assert.equal(results[0].success, false);
    assert.match(results[0].error, /exceeded its 60ms timeout/);
});

test('W2.8: a tool that finishes in time is unaffected', async () => {
    const results = /** @type {any[]} */ (await executeTools({
        toolCalls: [{ id: 'c1', name: 'quick', arguments: '{}' }],
        toolLibrary: [{
            name: 'quick',
            description: 'fast',
            parameters: { type: 'object', properties: {} },
            timeoutMs: 5000,
            execute: async () => 'done'
        }]
    }));
    assert.equal(results[0].success, true);
    assert.equal(results[0].result, 'done');
});

// ── W2.9 tool output validation ──────────────────────────────────────────────

test('W2.9: a result that violates the tool outputSchema fails the call', async () => {
    const results = /** @type {any[]} */ (await executeTools({
        toolCalls: [{ id: 'c1', name: 'shaped', arguments: '{}' }],
        toolLibrary: [{
            name: 'shaped',
            description: 'returns an object',
            parameters: { type: 'object', properties: {} },
            outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
            execute: async () => ({ count: 'not a number' })
        }]
    }));
    assert.equal(results[0].success, false);
    assert.match(results[0].error, /does not match its outputSchema/);
});

test('W2.9: a result that honours the outputSchema passes', async () => {
    const results = /** @type {any[]} */ (await executeTools({
        toolCalls: [{ id: 'c1', name: 'shaped', arguments: '{}' }],
        toolLibrary: [{
            name: 'shaped',
            description: 'returns an object',
            parameters: { type: 'object', properties: {} },
            outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
            execute: async () => ({ count: 3 })
        }]
    }));
    assert.equal(results[0].success, true);
    assert.deepEqual(results[0].result, { count: 3 });
});

// ── W2.10 object output capping ──────────────────────────────────────────────

test('W2.10: an oversized object result is capped, not passed through', async () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const truncations = [];
    emitter.on(EVENTS.TOOL.OUTPUT_TRUNCATED, (e) => truncations.push(e.payload ?? e));
    const results = /** @type {any[]} */ (await executeTools({
        toolCalls: [{ id: 'c1', name: 'fat', arguments: '{}' }],
        toolLibrary: [{
            name: 'fat',
            description: 'returns a huge object',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ blob: 'x'.repeat(200_000), nested: { also: 'y'.repeat(200_000) } })
        }],
        emitter,
        runContext: new RunContext()
    }));
    assert.equal(results[0].success, true);
    assert.equal(typeof results[0].result, 'object', 'the result keeps its top-level shape');
    assert.equal(results[0].result.blob.length < 200_000, true, 'the string leaf was capped');
    assert.equal(results[0].result.nested, '[…]', 'the subtree that did not fit is elided');
    assert.equal(truncations.length, 1, 'the truncation is reported');
});

test('W2.10: a small object result is untouched', async () => {
    const results = /** @type {any[]} */ (await executeTools({
        toolCalls: [{ id: 'c1', name: 'small', arguments: '{}' }],
        toolLibrary: [{
            name: 'small',
            description: 'returns a small object',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ count: 3 })
        }]
    }));
    assert.deepEqual(results[0].result, { count: 3 });
});

// ── W2.11 the request:after hook ─────────────────────────────────────────────

test('W2.11: the request:after hook fires with the round trip', async () => {
    const hooks = createHooks();
    /** @type {any[]} */
    const seen = [];
    hooks.add({ name: 'request:after', fn: (/** @type {any} */ ctx) => { seen.push(ctx); } });
    const session = stubSession();
    session.withHooks({ hooks });
    const gen = session.step({ messages: [] });
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    assert.equal(seen.length, 1, 'the after-chain ran once');
    assert.equal(seen[0].response.ok, true);
    assert.equal(typeof seen[0].response.durationMs, 'number');
    assert.ok(seen[0].session, 'the hook sees the session');
    assert.ok(seen[0].request, 'the hook sees the request that was sent');
});

test('W2.14: the vendor citations reach the step result', async () => {
    const adapter = {
        vendorName: 'STUB',
        buildVendorRequest: () => ({ request: { marker: 'original' }, observability: { model: 'm' } }),
        executeVendorRequest: () => ({}),
        consumeStream: async function* () {
            yield { type: 'citations', data: { citations: [{ uri: 'https://example.com/a', title: 'A', text: 'quoted' }] } };
            yield { type: 'text', content: 'hi' };
        },
        extractXmlToolCalls: () => [],
        formatToolCall: (/** @type {any} */ { call }) => ({ id: call.id, name: call.name, args: {} })
    };
    const session = new (class extends BaseChatSession {})({
        vendorClient: {},
        model: 'm',
        eventEmitter: new EventEmitter(),
        provider: ProviderType.OPENAI,
        adapter,
        buildParameters: (/** @type {any} */ { s }) => s
    });
    const gen = session.step({ messages: [] });
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const result = /** @type {any} */ (r.value);
    assert.deepEqual(result.citations, [{ uri: 'https://example.com/a', title: 'A', text: 'quoted' }]);
});

test('W2.11: a request:after hook that throws does not break the run', async () => {
    const hooks = createHooks();
    hooks.add({ name: 'request:after', fn: () => { throw new Error('observer exploded'); } });
    const session = stubSession();
    session.withHooks({ hooks });
    const gen = session.step({ messages: [] });
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    assert.equal((/** @type {any} */ (r.value)).done, true, 'the step still finished');
});

// ── W2.3 guardrails ──────────────────────────────────────────────────────────

test('W2.3: an input guardrail blocks the run before the model is called', async () => {
    const session = fakeSession();
    session._guardrails = {
        check: () => ({ blocked: true, rule: { name: 'no-secrets', action: 'block', phase: 'input' }, phase: 'input', message: 'nope' })
    };
    let called = false;
    session.step = async function* () { called = true; };
    await assert.rejects(
        () => runAgenticLoop({ session, messages: [{ role: 'user', content: 'AKIA...' }] }),
        (err) => {
            assert.ok(err instanceof GuardrailViolationError);
            assert.equal(err.code, ERROR_CODES.GUARDRAIL);
            assert.equal(err.phase, 'input');
            return true;
        }
    );
    assert.equal(called, false, 'the model was never called');
});

test('W2.3: an output guardrail blocks the answer', async () => {
    const session = fakeSession({ content: 'the answer' });
    session._guardrails = {
        check:
            /** @param {{phase: string}} arg0 */
            ({ phase }) => (phase === 'output'
                ? { blocked: true, rule: { name: 'no-leak', action: 'block', phase: 'output' }, phase: 'output', message: 'leaked' }
                : { blocked: false, rule: null, phase })
    };
    await assert.rejects(
        () => runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] }),
        (err) => {
            assert.ok(err instanceof GuardrailViolationError);
            assert.equal(err.phase, 'output');
            return true;
        }
    );
});

test('W2.3: a warn rule reports the match and lets the run continue', async () => {
    const session = fakeSession();
    session._guardrails = {
        check:
            /** @param {{phase: string}} arg0 */
            ({ phase }) => (phase === 'input'
                ? { blocked: false, rule: { name: 'watch', action: 'warn', phase }, phase, message: 'watched' }
                : { blocked: false, rule: null, phase })
    };
    /** @type {any[]} */
    const tripped = [];
    session.emitter.on(EVENTS.GUARDRAIL.TRIPPED, (/** @type {any} */ e) => tripped.push(e.payload ?? e));
    const out = await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] });
    assert.equal(out, 'hi');
    assert.equal(tripped.length, 1);
    assert.equal(tripped[0].blocked, false);
});

test('W2.3: withGuardrails installs the rules', async () => {
    const builder = new ChatSessionBuilder();
    builder.withGuardrails({ rules: [{ name: 'r', pattern: /x/, phase: 'input' }] });
    assert.ok(builder._guardrails);
    assert.equal(builder._guardrails.rules.length, 1);
    assert.equal((await builder._guardrails.check({ phase: 'input', text: 'axb' })).blocked, true);
    assert.equal((await builder._guardrails.check({ phase: 'output', text: 'axb' })).blocked, false, 'the rule watches one side');
});

// ── W2.4 permission rules ────────────────────────────────────────────────────

test('W2.4: the allow list decides which tools the model sees', () => {
    const builder = new ChatSessionBuilder();
    builder.withTools({ tools: [
        { name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} }, execute: async () => 'r' },
        { name: 'write_file', description: 'w', parameters: { type: 'object', properties: {} }, execute: async () => 'w' }
    ] });
    assert.equal(builder._tools.length, 2);
    builder.withPermissions({ allow: ['read_*'] });
    assert.deepEqual(builder._tools.map((t) => t.name), ['read_file']);
});

test('W2.4: the deny list wins over the allow list', () => {
    const builder = new ChatSessionBuilder();
    builder.withTools({ tools: [
        { name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} }, execute: async () => 'r' },
        { name: 'write_file', description: 'w', parameters: { type: 'object', properties: {} }, execute: async () => 'w' }
    ] });
    builder.withPermissions({ allow: ['*'], deny: ['write_*'] });
    assert.deepEqual(builder._tools.map((t) => t.name), ['read_file']);
});

test('C: an argument pattern in allow throws instead of matching nothing', () => {
    assert.throws(() => new ChatSessionBuilder().withPermissions({ allow: ['Bash(git:*)'] }), (/** @type {any} */ err) => err instanceof ConfigurationError && /Bash\(git:\*\)/.test(err.message));
});

test('C: an argument pattern in deny throws instead of silently denying nothing', () => {
    assert.throws(() => new ChatSessionBuilder().withPermissions({ deny: ['Bash(rm:*)'] }), ConfigurationError);
});

test('W2.4: bypassPermissions skips the approval gate, default does not', async () => {
    /** @type {any[]} */
    const asked = [];
    const tool = {
        name: 'dangerous',
        description: 'd',
        parameters: { type: 'object', properties: {} },
        requiresApproval: true,
        execute: async () => 'ran'
    };
    const askedDefault = /** @type {any[]} */ (await executeTools({
        toolCalls: [{ id: 'c1', name: 'dangerous', arguments: '{}' }],
        toolLibrary: [tool],
        approval: { callback: approvalAsker({ asked }), timeoutMs: 100 }
    }));
    assert.deepEqual(asked, ['dangerous'], 'the default mode asks');
    assert.equal(askedDefault[0].success, true);

    /** @type {any[]} */
    const askedBypass = [];
    const bypassed = /** @type {any[]} */ (await executeTools({
        toolCalls: [{ id: 'c1', name: 'dangerous', arguments: '{}' }],
        toolLibrary: [tool],
        approval: { callback: approvalAsker({ asked: askedBypass }), timeoutMs: 100 },
        permissionMode: 'bypassPermissions'
    }));
    assert.equal(askedBypass.length, 0, 'the gate is skipped');
    assert.equal(bypassed[0].success, true);
});

test('W2.4: the session stores the permission mode and the tool round honours it', async () => {
    // The chain the builder starts: the mode is stored on the session, the
    // loop hands it to the tool round, and the round decides whether the
    // gated tool still has to ask. There is NO approval handler here, so the
    // mode is the only thing that can let the tool run.
    const run = async (/** @type {string} */ mode) => {
        const executed = { n: 0 };
        const session = {
            provider: ProviderType.OPENAI,
            model: 'gpt-4o',
            _tools: [{
                name: 'dangerous',
                description: 'd',
                parameters: { type: 'object', properties: {} },
                requiresApproval: true,
                execute: async () => { executed.n += 1; return 'ran'; },
            }],
            _permissionRules: { allow: [], deny: [], mode },
            eventEmitter: new EventEmitter(),
            /**
             * @param {{messages: any[]}} arg0
             */
            async *step({ messages }) {
                yield { type: 'tool_request', calls: [{ id: 'c1', name: 'dangerous', args: '{}' }] };
                return { done: true, content: 'hi', messages: [...messages, { role: 'assistant', content: 'hi' }] };
            }
        };
        await runAgenticLoop({ session, messages: [{ role: 'user', content: 'go' }] });
        return executed;
    };

    const bypassed = await run('bypassPermissions');
    const denied = await run('default');
    assert.equal(bypassed.n, 1, 'bypassPermissions runs the gated tool without asking');
    assert.equal(denied.n, 0, 'the default mode denies a gated tool that has no approval handler');
});

test('W2.4: acceptEdits approves edit-like tools only', async () => {
    // G2-3: the old fixture was the bug — a bare tool name is not the brand,
    // so `write_file` is approved only when it carries `editsFiles: true`.
    const make = (/** @type {string} */ name, /** @type {Record<string, unknown>} */ extra = {}) => ({
        name,
        description: 'd',
        parameters: { type: 'object', properties: {} },
        requiresApproval: true,
        ...extra,
        execute: async () => 'ran'
    });
    /** @type {any[]} */
    const asked = [];
    const results = /** @type {any[]} */ (await executeTools({
        toolCalls: [{ id: 'c1', name: 'write_file', arguments: '{}' }, { id: 'c2', name: 'run_shell', arguments: '{}' }],
        toolLibrary: [make('write_file', { editsFiles: true }), make('run_shell')],
        approval: { callback: approvalAsker({ asked }), timeoutMs: 100 },
        permissionMode: 'acceptEdits'
    }));
    assert.deepEqual(asked, ['run_shell'], 'only the non-edit tool asked');
    assert.equal(results[0].success, true);
    assert.equal(results[1].success, true);

    // The same name with no brand asks: the name alone approves nothing (G2-3).
    /** @type {any[]} */
    const askedUnbranded = [];
    const unbranded = /** @type {any[]} */ (await executeTools({
        toolCalls: [{ id: 'c3', name: 'write_file', arguments: '{}' }],
        toolLibrary: [make('write_file')],
        approval: { callback: approvalAsker({ asked: askedUnbranded }), timeoutMs: 100 },
        permissionMode: 'acceptEdits'
    }));
    assert.deepEqual(askedUnbranded, ['write_file'], 'an unbranded tool asks, whatever its name');
    assert.equal(unbranded[0].success, true, 'approved by the human, not by the mode');
});

// ── W2.6 streaming input ─────────────────────────────────────────────────────

test('W2.6: the streamed input accumulates the turns of the conversation', async () => {
    const builder = new ChatSessionBuilder();
    /** @type {string[][]} */
    const turns = [];
    builder._runOnce = async ({ initialInput }) => {
        const rows = /** @type {any[]} */ (initialInput);
        turns.push(rows.map((m) => String(m.content)));
        return 'ok';
    };
    async function* input() {
        yield 'first';
        yield 'second';
    }
    await builder.run({ initialInput: /** @type {any} */ (input()) });
    assert.equal(turns.length, 2, 'each chunk is its own turn');
    assert.equal(turns[0].length, 1, 'the first turn holds the first chunk');
    assert.equal(turns[1].length, 2, 'the second turn holds both chunks — the conversation accumulates');
});

test('W2.6: the builder consumes an async iterable as a streamed input', async () => {
    const builder = new ChatSessionBuilder();
    /** @type {string[]} */
    const seen = [];
    builder._runOnce = async ({ initialInput }) => {
        seen.push(String((/** @type {any} */ (initialInput))?.content ?? ''));
        return 'ok';
    };
    async function* input() {
        yield 'one';
        yield 'two';
    }
    const answer = await builder.run({ initialInput: /** @type {any} */ (input()) });
    assert.equal(answer, 'ok');
    assert.equal(seen.length, 2, 'each chunk is its own turn');
});
