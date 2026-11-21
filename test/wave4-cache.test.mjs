// @ts-check

/**
 * Wave 4 — prompt caching.
 *
 * These checks encode the design `fix-plan.md` §0 validated: the cache breakpoint
 * must sit on the part of the prompt that does NOT change between iterations, and
 * the volatile live-state block (todos, memory, skills) must land AFTER it.
 *
 * They are written against the unfixed tree and are EXPECTED TO FAIL until wave 4's
 * steps 4.1–4.4 land. The provider algebra below is the documented Anthropic rule
 * (a write happens at a breakpoint; a later request reads the longest written prefix
 * that its own breakpoint still covers) applied to the real request bodies — it is
 * an independent oracle, not the SDK asserting about itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { ChatSession as AaiChatSession } from '../lib/backends/aai.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';
import { createUserMessage, createAssistantMessage, createToolCallMessage, createToolResultMessage } from '../lib/messaging/messages.mjs';

/** @returns {any} */
function makeSession() {
    const session = new AaiChatSession({
        client: { messages: { create: async () => { throw new Error('no transport in this check'); } } },
        model: 'claude-sonnet-test',
        eventEmitter: new EventEmitter(),
    });
    session.withSystemMessage('STABLE INSTRUCTIONS: you are a careful agent.');
    session.withTodos({ store: new Map(), options: { preload: true } });
    // The public policy entry point the engines use (4.4).
    session.withPromptCache({ points: 2 });
    return session;
}

/**
 * A stable string for any wire block — text, tool_use and tool_result all
 * participate in Anthropic's prefix, so hashing only `text` would alias two
 * different tool results into one cache hit.
 * @param {any} part
 * @returns {string}
 */
function blockKey(part) {
    if (typeof part.text === 'string') return part.text;
    if (part.type === 'tool_result') {
        const content = typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '');
        return `tool_result:${part.tool_use_id}:${content}`;
    }
    if (part.type === 'tool_use') return `tool_use:${part.id}:${part.name}:${JSON.stringify(part.input ?? '')}`;
    return JSON.stringify(part);
}

/**
 * The ordered blocks that make up Anthropic's cache prefix: tools → system → messages.
 * @param {any} request
 * @returns {Array<{kind: string, role?: string, text: string, marked?: boolean}>}
 */
function prefixBlocks(request) {
    const blocks = [];
    for (const tool of (request.tools ?? [])) {
        blocks.push({ kind: 'tool', text: `tool:${tool.name}:${tool.description ?? ''}` });
    }
    const systemBlocks = Array.isArray(request.system)
        ? request.system
        : (request.system ? [{ type: 'text', text: request.system }] : []);
    for (const block of systemBlocks) {
        blocks.push({ kind: 'system', text: String(block.text ?? ''), marked: !!block.cache_control });
    }
    for (const message of (request.messages ?? [])) {
        const parts = Array.isArray(message.content)
            ? message.content
            : [{ type: 'text', text: String(message.content ?? '') }];
        for (const part of parts) {
            blocks.push({
                kind: 'message',
                role: message.role,
                text: blockKey(part),
                marked: !!part.cache_control,
            });
        }
    }
    return blocks;
}

/** @param {Array<{kind: string, text: string}>} blocks @param {number} upTo */
const prefixHash = (blocks, upTo) => createHash('sha256')
    .update(blocks.slice(0, upTo + 1).map((b) => b.text).join('\u0000'))
    .digest('hex')
    .slice(0, 16);

/**
 * Simulates the documented algebra over the captured requests: a request reads a
 * prefix only when the longest prefix ending at one of ITS breakpoints was written
 * by an earlier request's breakpoint.
 * @param {any[]} requests
 * @returns {{reads: number, writes: number}}
 */
function cacheReads(requests) {
    /** @type {Set<string>} */
    const written = new Set();
    let reads = 0;
    let writes = 0;
    for (const request of requests) {
        const blocks = prefixBlocks(request);
        const marks = blocks.map((b, i) => (b.marked ? i : -1)).filter((i) => i >= 0);
        if (marks.length === 0) continue;
        const longest = Math.max(...marks);
        // A read must cover the whole SYSTEM row to count: matching only the tools
        // prefix would pass while the audited defect (a system row that changes
        // every iteration) is still present.
        const lastSystem = blocks.map((b, i) => (b.kind === 'system' ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
        // Anthropic reads the longest previously-cached prefix its breakpoint
        // still covers, and writes only the extension.
        const hashes = [];
        for (let i = 0; i <= longest; i++) hashes.push(prefixHash(blocks, i));
        if (hashes.some((h, i) => i >= lastSystem && written.has(h))) reads += 1;
        if (!written.has(hashes[longest])) writes += 1;
        for (const h of hashes) written.add(h);
    }
    return { reads, writes };
}

/** @param {any} session @param {any[]} messages */
async function captureRequest(session, messages) {
    // Drive the REAL step path and capture what the adapter built: the cache
    // anchor is assembled in `step()`, so calling the adapter directly would
    // test a path no engine uses.
    /** @type {any} */
    let captured = null;
    const original = session._adapter.buildVendorRequest;
    session._adapter.buildVendorRequest = (/** @type {any} */ args) => {
        const out = original(args);
        captured = out.request;
        return out;
    };
    try {
        const gen = session.step({ messages });
        let step = await gen.next();
        while (!step.done) {
            const event = step.value;
            step = await gen.next(event?.type === 'tool_request' ? [] : undefined);
        }
    } catch {
        // The fake transport has no wire; the request is already captured.
    } finally {
        session._adapter.buildVendorRequest = original;
    }
    assert.ok(captured, 'the adapter built a request');
    return captured;
}

test('W4/cache-anchor: the volatile live block sits after the breakpoint, not inside the system row', async () => {
    const session = makeSession();
    const first = await captureRequest(session, [createUserMessage({ provider: 'anthropic', content: 'Do X' })]);

    // The agent calls manage_todos: the store mutates, and the next iteration must
    // not drag that mutation into the cached prefix.
    await /** @type {any} */ (session._todoComponent).save({ args: { action: 'add', title: 'Ship the cache fix' } });
    const second = await captureRequest(session, [
        createUserMessage({ provider: 'anthropic', content: 'Do X' }),
        createAssistantMessage({ provider: 'anthropic', content: 'Saved the task.' }),
        createUserMessage({ provider: 'anthropic', content: 'Continue.' }),
    ]);

    const firstBlocks = prefixBlocks(first);
    const secondBlocks = prefixBlocks(second);
    const firstSystem = firstBlocks.filter((b) => b.kind === 'system').map((b) => b.text).join('\n');
    const secondSystem = secondBlocks.filter((b) => b.kind === 'system').map((b) => b.text).join('\n');
    assert.equal(secondSystem, firstSystem,
        'the system row is the cached prefix: a todo write must not change it');

    assert.ok(!secondSystem.includes('Ship the cache fix'),
        'the volatile todo block must not be part of the system row at all');

    const secondMarks = secondBlocks.map((b, i) => (b.marked ? i : -1)).filter((i) => i >= 0);
    assert.ok(secondMarks.length > 0, 'the request carries at least one cache breakpoint');
    const volatileAt = secondBlocks.findIndex((b) => b.text.includes('Ship the cache fix'));
    assert.ok(volatileAt > Math.max(...secondMarks),
        'the volatile block is a trailing row AFTER the last breakpoint (today it is inside system[0])');
});

test('W4/cache-read: two iterations of a todo-changing run produce a cache read', async () => {
    const session = makeSession();
    const first = await captureRequest(session, [createUserMessage({ provider: 'anthropic', content: 'Do X' })]);
    await /** @type {any} */ (session._todoComponent).save({ args: { action: 'add', title: 'Ship the cache fix' } });
    const second = await captureRequest(session, [
        createUserMessage({ provider: 'anthropic', content: 'Do X' }),
        createAssistantMessage({ provider: 'anthropic', content: 'Saved the task.' }),
        createUserMessage({ provider: 'anthropic', content: 'Continue.' }),
    ]);

    const { reads, writes } = cacheReads([first, second]);
    assert.ok(reads >= 1,
        `the second iteration must READ the cached prefix (observed reads=${reads}, writes=${writes})`);
});

// ─── 4.4 — the engines can enable it ────────────────────────────────────────

/**
 * Fake client whose session records the cache policy the step applies.
 * @returns {any}
 */
function makePolicyClient() {
    /** @type {any[]} */
    const sessions = [];
    return {
        sessions,
        session: (/** @type {any} */ model) => {
            const s = {
                provider: 'openai',
                model,
                _tools: [],
                /** @type {number|undefined} */
                cachePoints: undefined,
                eventEmitter: { emit() {} },
                withSystemMessage() { return s; },
                withTools() { return s; },
                withMemory() { return s; },
                withTodos() { return s; },
                withParameters() { return s; },
                withCircuitBreaker() { return s; },
                /** @param {{points?: number}} [arg0] */
                withPromptCache({ points = 1 } = {}) { s.cachePoints = points; return s; },
                async run() { return 'ok'; },
            };
            sessions.push(s);
            return s;
        },
    };
}

test('W4/engine: a DAG step with promptCache enables caching on its session', async () => {
    const { WorkflowExecutor } = await import('../lib/agentic/planning/executor.mjs');
    const client = makePolicyClient();
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', promptCache: true } });
    executor.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 's', userPromptTemplate: 'Do A.', dependencies: [] }] });
    await executor.execute({ userGoal: 'goal' });
    assert.equal(client.sessions[0].cachePoints, 1, 'the engine policy reaches the step session');
});

test('W4/engine: a StateMachine with promptCache enables caching on its node session', async () => {
    const client = makePolicyClient();
    const sm = new StateMachine({ graph: {
        entry: 'a',
        nodes: [{ id: 'a', model: 'm', userPromptTemplate: 'Do A.', terminal: true }],
        edges: [],
    }, options: { client, defaultModel: 'm', promptCache: true } });
    await sm.run();
    assert.equal(client.sessions[0].cachePoints, 1, 'the machine policy reaches the node session');
});

// ─── 4.5 — the tools level is stable across a mid-run registration ──────────

test('W4/tools: the subagent roster is snapshotted, so a late registration cannot move cache level 1', async () => {
    const session = new AaiChatSession({
        client: { messages: { create: async () => { throw new Error('no transport in this check'); } } },
        model: 'm',
        eventEmitter: new EventEmitter(),
    });
    session.withTaskAgents({ agents: [{ name: 'alpha', model: 'm', description: 'Alpha agent' }] });
    /** @param {any} s */
    const taskDescription = (s) => String((s._tools ?? []).find((/** @type {any} */ t) => t.name === 'task')?.description ?? '');
    const before = taskDescription(session);
    assert.ok(before.includes('alpha'), 'the roster reaches the tool description');

    session.withTaskAgents({ agents: [
        { name: 'alpha', model: 'm', description: 'Alpha agent' },
        { name: 'beta', model: 'm', description: 'Beta agent' },
    ] });
    assert.equal(taskDescription(session), before,
        'the description is the cache level-1 prefix: it must not change mid-run');
});

// ─── 4.6 — the counters the provider reports reach the run usage ────────────

test('W4/counters: a provider cache read reaches the run usage', async () => {
    const { runAgenticLoop } = await import('../lib/agentic/agentic-core.mjs');
    /** @type {any} */
    const session = {
        provider: 'anthropic',
        model: 'm',
        _tools: [],
        eventEmitter: new EventEmitter(),
        /** @param {{messages: any[]}} arg0 */
        async *step({ messages }) {
            yield { type: 'quota', data: { prompt_tokens: 10, completion_tokens: 5, cache_read_input_tokens: 40 } };
            yield { type: 'text', content: 'done' };
            return { done: true, content: 'done', messages, thoughtSignature: null };
        },
    };
    await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'anthropic', content: 'hi' })], opts: { maxIterations: 2 } });
    assert.equal(session._lastRunUsage?.cache_read_input_tokens, 40,
        'the cache counters the provider reports must survive into the usage snapshot');
});

test('W4/anchor: a step that skips preparation marks nothing instead of a stale tail', async () => {
    const session = makeSession();
    await captureRequest(session, [createUserMessage({ provider: 'anthropic', content: 'Do X' })]);
    // A hook may bypass `_prepareStepMessages`; the anchor from the previous step
    // must not survive, and the adapter must not fall back to marking the tail.
    session._onStepShouldPrepare = () => false;
    const request = await captureRequest(session, [
        createUserMessage({ provider: 'anthropic', content: 'Do X' }),
        createAssistantMessage({ provider: 'anthropic', content: 'ok' }),
        createUserMessage({ provider: 'anthropic', content: 'Continue.' }),
    ]);
    const marks = prefixBlocks(request).filter((b) => b.marked);
    assert.equal(marks.length, 0, 'no anchor, no marker — never the volatile tail');
});

// ─── findings from the independent wave-4 verifier ──────────────────────────

test('W4/anchor-tool: a tool-round tail still anchors the cache, on the tool result', async () => {
    const session = makeSession();
    await session._todoComponent.save({ args: { action: 'add', title: 'Ship the cache fix' } });
    const request = await captureRequest(session, [
        createUserMessage({ provider: 'anthropic', content: 'Do X' }),
        createToolCallMessage({ provider: 'anthropic', id: 't1', name: 'manage_todos', args: { action: 'add' } }),
        createToolResultMessage({ provider: 'anthropic', result: { id: 't1', name: 'manage_todos', success: true, result: { ok: true } } }),
    ]);
    const blocks = prefixBlocks(request);
    const marks = blocks.map((b, i) => (b.marked ? i : -1)).filter((i) => i >= 0);
    assert.ok(marks.length >= 1, 'a tool-round tail must still be cacheable');
    const volatileAt = blocks.findIndex((b) => b.text.includes('Ship the cache fix'));
    assert.ok(volatileAt > Math.max(...marks), 'the volatile block stays after every breakpoint');
    assert.ok(blocks.some((b) => b.marked && b.text.startsWith('tool_result:t1')), 'the tool result is the anchor');
});

test('W4/points: the breakpoint budget is honoured and every breakpoint is on the stable prefix', async () => {
    const session = makeSession();
    session.withPromptCache({ points: 3 });
    const request = await captureRequest(session, [
        createUserMessage({ provider: 'anthropic', content: 'one' }),
        createAssistantMessage({ provider: 'anthropic', content: 'two' }),
        createUserMessage({ provider: 'anthropic', content: 'three' }),
        createAssistantMessage({ provider: 'anthropic', content: 'four' }),
        createUserMessage({ provider: 'anthropic', content: 'five' }),
    ]);
    const marked = prefixBlocks(request).filter((b) => b.marked);
    assert.equal(marked.length, 3, 'points: 3 asks for three breakpoints');
    assert.ok(!marked.some((b) => b.text.includes('Active Task List')), 'none on the volatile block');
});

test('W4/ttl: an extended cache carries {type: ephemeral, ttl: 1h}', async () => {
    const session = makeSession();
    session.withPromptCache({ ttl: '1h' });
    const request = await captureRequest(session, [createUserMessage({ provider: 'anthropic', content: 'Do X' })]);
    const blocks = (request.messages ?? []).flatMap((/** @type {any} */ m) => (Array.isArray(m.content) ? m.content : []));
    const marked = blocks.find((/** @type {any} */ b) => b.cache_control);
    assert.deepEqual(marked.cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('W4/no-leak: enabling caching on a non-Anthropic session adds no private parameter', async () => {
    const session = new OaiChatSession({
        client: {
            chat: { completions: { create: async () => { throw new Error('no transport in this check'); } } },
            messages: { create: async () => { throw new Error('no transport in this check'); } },
        },
        model: 'gpt-test',
        eventEmitter: new EventEmitter(),
    });
    session.withPromptCache({ points: 2 });
    assert.equal('_cachePoints' in (session._parameters ?? {}), false, 'the policy never enters the vendor param bag');
    const request = await captureRequest(session, [createUserMessage({ provider: 'openai', content: 'hi' })]);
    const leaked = Object.keys(request).filter((k) => k.startsWith('_cache'));
    assert.deepEqual(leaked, [], 'no cache parameter reaches the OpenAI body');
});

test('W4/tools-late: an agent registered after the session is discovered, then the roster freezes', () => {
    const session = new AaiChatSession({
        client: { messages: { create: async () => { throw new Error('no transport in this check'); } } },
        model: 'm',
        eventEmitter: new EventEmitter(),
    });
    /** @param {any} s */
    const taskDescription = (s) => String((s._tools ?? []).find((/** @type {any} */ t) => t.name === 'task')?.description ?? '');
    // Before any agent exists `_canDelegate()` hides the task tool, so the roster
    // code is not reached with an empty registry; this pins late discovery plus the
    // freeze once a non-empty roster exists.
    assert.ok(!taskDescription(session).includes('alpha'));
    session.withTaskAgents({ agents: [{ name: 'alpha', model: 'm', description: 'Alpha agent' }] });
    const afterRegistration = taskDescription(session);
    assert.ok(afterRegistration.includes('alpha'), 'a late registration is still discovered');

    session.withTaskAgents({ agents: [
        { name: 'alpha', model: 'm', description: 'Alpha agent' },
        { name: 'beta', model: 'm', description: 'Beta agent' },
    ] });
    assert.equal(taskDescription(session), afterRegistration, 'a non-empty snapshot stays frozen for the session');
});

test('W4/f5-wire: the volatile row after a tool result keeps tool pairing intact', async () => {
    const session = makeSession();
    await session._todoComponent.save({ args: { action: 'add', title: 'Ship the cache fix' } });
    const request = await captureRequest(session, [
        createUserMessage({ provider: 'anthropic', content: 'add a task' }),
        createToolCallMessage({ provider: 'anthropic', id: 't1', name: 'manage_todos', args: { action: 'add' } }),
        createToolResultMessage({ provider: 'anthropic', result: { id: 't1', name: 'manage_todos', success: true, result: { ok: true } } }),
    ]);
    const messages = request.messages ?? [];
    /** @param {any} m @param {any} pred */
    const has = (m, pred) => Array.isArray(m.content) && m.content.some(pred);
    const toolUseAt = messages.findIndex((/** @type {any} */ m) => has(m, (/** @type {any} */ b) => b.type === 'tool_use' && b.id === 't1'));
    const toolResultAt = messages.findIndex((/** @type {any} */ m) => has(m, (/** @type {any} */ b) => b.type === 'tool_result' && b.tool_use_id === 't1'));
    assert.ok(toolUseAt >= 0, 'the tool call is on the wire');
    assert.equal(toolResultAt, toolUseAt + 1, 'tool_use is immediately followed by its tool_result');
    const volatileAt = messages.findIndex((/** @type {any} */ m) => JSON.stringify(m.content ?? '').includes('Ship the cache fix'));
    assert.ok(volatileAt > toolResultAt, 'the volatile block is after the tool round');
});

/** @param {any} request */
const countMarks = (request) => (request?.messages ?? [])
    .flatMap((/** @type {any} */ m) => (Array.isArray(m.content) ? m.content : []))
    .filter((/** @type {any} */ b) => b?.cache_control).length;

test('W4/no-accumulate: marking never writes cache_control back into the session history', async () => {
    /** @type {any[]} */
    const requests = [];
    const client = { messages: { stream: async (/** @type {any} */ req) => {
        requests.push(req);
        return (async function* () {
            yield { type: 'message_start', message: { usage: {} } };
            yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } };
        })();
    } } };
    const session = new AaiChatSession({ client, model: 'm', eventEmitter: new EventEmitter() });
    session.withSystemMessage('S');
    session.withPromptCache({ points: 1 });
    const history = [
        createUserMessage({ provider: 'anthropic', content: 'one' }),
        createToolCallMessage({ provider: 'anthropic', id: 't1', name: 'x', args: {} }),
        createToolResultMessage({ provider: 'anthropic', result: { id: 't1', name: 'x', success: true, result: { ok: true } } }),
    ];
    /** @param {any[]} messages */
    const drain = async (messages) => {
        const gen = session.step({ messages });
        let st = await gen.next();
        while (!st.done) st = await gen.next();
        return st.value;
    };
    const first = /** @type {any} */ (await drain(history));
    assert.ok(!JSON.stringify(history).includes('cache_control'), 'the caller history is not mutated');
    assert.equal(countMarks(requests.at(-1)), 1, 'one marker on the first request');
    await drain(first.messages ?? history);
    assert.equal(countMarks(requests.at(-1)), 1, 'a later iteration carries one marker, not a pile');
});
