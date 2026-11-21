// @ts-check

/**
 * Wave 5 — handoff honesty (D3, D4, E6, E7).
 *
 * Check-first: these are written against the pre-fix tree and are EXPECTED TO
 * FAIL for the four findings, except the two pins marked `pin` (behavior that
 * already works and must not regress).
 *
 * D3 — `handoff.context` advertises clean|full|moderated|fork, but 'full' and
 *      'moderated' delivered nothing on the delegation path.
 * E6 — the A2A server dropped the merci envelope the client sends.
 * E7 — `handoff.tools: [...]` did not restrict the tools the child can see.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { withTaskAgents, createTaskTool } from '../lib/agentic/task.mjs';
import { createA2AServer } from '../lib/tools/a2a-server.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';

/**
 * Fake client whose child session records what the task tool hands it.
 * @param {string} provider
 * @returns {any}
 */
function makeClient(provider = 'openai') {
    /** @type {any[][]} */
    const runs = [];
    /** @type {any[]} */
    const permissions = [];
    /** @type {any[]} */
    const toolCalls = [];
    /** @type {any[]} */
    const allowlists = [];
    /** @type {any[]} */
    const sessions = [];
    return {
        provider,
        runs,
        permissions,
        toolCalls,
        allowlists,
        sessions,
        /** @param {string} model */
        session(model) {
            const s = {
                provider,
                model,
                /** @type {any} */
                _permissionRules: null,
                /** @type {any} */
                _toolAllowlists: null,
                withSystemMessage() { return s; },
                /** @param {{tools: any}} arg0 */
                withTools({ tools }) { toolCalls.push(tools); return s; },
                withRetryPolicy() { return s; },
                withHeaderTimeout() { return s; },
                withMaxElapsedMs() { return s; },
                withApproval() { return s; },
                withBudget() { return s; },
                withCircuitBreaker() { return s; },
                /** @param {any} rules */
                withPermissions(rules) {
                    permissions.push(rules);
                    s._permissionRules = { allow: rules.allow ?? [], deny: rules.deny ?? [], mode: rules.mode ?? 'default' };
                    return s;
                },
                /** @param {{patterns?: string[]}} [arg0] */
                withToolAllowlist({ patterns = [] } = {}) { allowlists.push(patterns); return s; },
                /** @param {{initialInput: any[]}} arg0 */
                async run({ initialInput }) { runs.push(initialInput); return 'child answer'; },
            };
            sessions.push(s);
            return s;
        },
    };
}

/**
 * @param {{client: any, last?: any[], rules?: any}} arg0
 * @returns {any}
 */
function parentSession({ client, last = [], rules = null }) {
    return {
        client,
        model: 'parent-model',
        provider: client.provider,
        eventEmitter: new EventEmitter(),
        _taskDepth: 0,
        _lastStepMessages: last,
        ...(rules ? { _permissionRules: rules } : {}),
    };
}

const U = { role: 'user', content: 'parent question', merciId: 'm1' };
const A = { role: 'assistant', content: 'parent answer', merciId: 'm2' };
const B = { role: 'user', content: 'third turn', merciId: 'm3' };

/** @param {any[]} input */
const joined = (input) => input.map((m) => String(m?.content ?? '')).join('\n');

/**
 * @param {{handoff?: any, profile?: any, last?: any[], rules?: any, parentLayers?: string[][]|null}} arg0
 * @returns {Promise<any>}
 */
async function delegate({ handoff = undefined, profile = {}, last = [U, A, B], rules = null, parentLayers = null } = {}) {
    const client = makeClient('openai');
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm', ...profile }] });
    const session = parentSession({ client, last, rules });
    if (parentLayers) session._toolAllowlists = parentLayers;
    await /** @type {any} */ (createTaskTool({ session })).execute({
        args: { prompt: 'Do X', subagent_type: 'worker', ...(handoff ? { handoff } : {}) },
    });
    return { client, session, input: client.runs[0] };
}

// ─── D3 — the enum delivers what it says ────────────────────────────────────

test('W5/context-full: context:"full" replays the whole parent conversation', async () => {
    const { input } = await delegate({ handoff: { context: 'full', goal: 'clean' } });
    const text = joined(input);
    assert.ok(text.includes('parent question'), 'the first parent turn is present');
    assert.ok(text.includes('parent answer'));
    assert.ok(text.includes('third turn'), 'the whole history, not a tail');
    assert.ok(text.includes('Do X'), 'the delegation brief still closes the input');
});

test('W5/context-moderated: context:"moderated" delivers the compacted digest', async () => {
    const { input } = await delegate({ handoff: { context: 'moderated', goal: 'clean' } });
    const text = joined(input);
    assert.ok(text.includes('[Parent conversation (recent'), 'the digest is framed as a summary');
    assert.ok(text.includes('parent question'), 'the digest carries the parent text');
    assert.ok(text.includes('Do X'));
    assert.equal(input.length, 1, 'a digest is text, not replayed rows');
});

test('W5/context-clean: context:"clean" still carries nothing (pin)', async () => {
    const { input } = await delegate({ handoff: { context: 'clean', goal: 'clean' } });
    assert.equal(input.length, 1, 'only the brief');
    assert.ok(!joined(input).includes('parent question'));
});

test('W5/context-fork: context:"fork" replays real rows (pin)', async () => {
    const { input } = await delegate({ handoff: { context: 'fork', goal: 'clean' } });
    assert.equal(input.length, 4, 'three parent rows + the brief');
    assert.ok(joined(input).includes('parent question'));
});

// ─── E6 — the server reads the envelope it is sent ──────────────────────────

test('W5/a2a-envelope: the skill receives the merci envelope as agentContext', async () => {
    /** @type {any[]} */
    const seen = [];
    const server = createA2AServer({
        skills: [{
            id: 'echo',
            name: 'echo',
            description: 'echo',
            /** @param {any} args @param {any} ctx */
            async execute(args, ctx) { seen.push({ args, ctx }); return 'ok'; },
        }],
    });
    const response = await server.handle({
        method: 'message/send',
        id: 1,
        params: {
            message: { messageId: 'm1', role: 'user', parts: [{ text: JSON.stringify({ topic: 'x' }) }] },
            metadata: { skillId: 'echo', merci: { objective: 'ROOT OBJECTIVE', directive: 'be terse', refs: { file: 'a.js' } } },
        },
    });
    assert.ok(response?.result, 'the request succeeds');
    assert.equal(seen.length, 1, 'the skill ran');
    assert.deepEqual(seen[0].args, { topic: 'x' }, 'the call arguments are unchanged');
    assert.equal(seen[0].ctx.agentContext?.objective, 'ROOT OBJECTIVE', 'the objective survives the wire');
    assert.equal(seen[0].ctx.agentContext?.directive, 'be terse');
    assert.deepEqual(seen[0].ctx.agentContext?.refs, { file: 'a.js' });

    // Legacy peers send the same envelope as a top-level `_merci`.
    await server.handle({
        method: 'message/send',
        id: 2,
        params: {
            message: { messageId: 'm2', role: 'user', parts: [{ text: JSON.stringify({ topic: 'y' }) }] },
            _merci: { objective: 'LEGACY OBJECTIVE' },
        },
    });
    assert.equal(seen[1].ctx.agentContext?.objective, 'LEGACY OBJECTIVE', 'the legacy envelope is read too');
});

test('W5/a2a-invalid-envelope: a malformed envelope is a client error, not a crash', async () => {
    const server = createA2AServer({
        skills: [{ id: 'echo', name: 'echo', description: 'echo', async execute() { return 'ok'; } }],
    });
    /** @type {any} */
    let response;
    try {
        response = await server.handle({
            method: 'message/send',
            id: 3,
            params: {
                message: { messageId: 'm3', role: 'user', parts: [{ text: '{}' }] },
                metadata: { merci: { objective: 5 } },
            },
        });
    } catch (err) {
        assert.fail(`the handler must answer, not reject: ${(/** @type {any} */ (err))?.message ?? err}`);
    }
    assert.equal(response?.error?.code, -32602, 'JSON-RPC invalid-params, not a rejected handler');
    assert.ok(String(response?.error?.message).includes('objective'), 'the error names the field');
    assert.equal(response?.result, undefined, 'no task ran');
});

// ─── E7 — handoff.tools restricts the tool surface ──────────────────────────

test('W5/tools-allowlist: an array becomes the child allowlist, without rewriting the parent policy', async () => {
    const { client } = await delegate({ handoff: { tools: ['manage_todos'] } });
    assert.equal(client.allowlists.length, 1, 'the child received an allowlist');
    assert.deepEqual(client.allowlists[0], ['manage_todos']);
    assert.equal(client.permissions.length, 0, 'the inherited permission rules are never replaced');
});

test('W5/tools-none: "none" closes the tool surface completely', async () => {
    const { client } = await delegate({ handoff: { tools: 'none' } });
    assert.deepEqual(client.allowlists[0], [], 'an empty allowlist means no tool');

    const session = new OaiChatSession({
        client: { chat: { completions: { create: async () => { throw new Error('no transport in this check'); } } } },
        model: 'm',
        eventEmitter: new EventEmitter(),
    });
    session.withTodos({ store: new Map() });
    session.withToolAllowlist({ patterns: [] });
    assert.deepEqual((session._tools ?? []).map((/** @type {any} */ t) => t.name), [], 'capability tools are gone too');
});

test('W5/tools-compose: the child allowlist composes with the parent allow and deny', () => {
    /** @param {{allow?: string[], deny?: string[], patterns: string[]}} arg0 */
    const toolsFor = ({ allow = [], deny = [], patterns }) => {
        const session = new OaiChatSession({
            client: { chat: { completions: { create: async () => { throw new Error('no transport in this check'); } } } },
            model: 'm',
            eventEmitter: new EventEmitter(),
        });
        session.withTodos({ store: new Map() });
        session.withPermissions({ allow, deny });
        session.withToolAllowlist({ patterns });
        return (session._tools ?? []).map((/** @type {any} */ t) => t.name);
    };

    assert.deepEqual(toolsFor({ allow: ['manage_todos'], patterns: ['manage_*'] }), ['manage_todos'],
        'a glob composes with a literal parent allow');
    assert.deepEqual(toolsFor({ deny: ['manage_todos'], patterns: ['manage_*'] }), [],
        'the parent deny still wins over the allowlist');
    assert.deepEqual(toolsFor({ allow: ['manage_todos'], patterns: ['run_command'] }), [],
        'a request for a tool the parent withholds grants nothing');
    assert.deepEqual(toolsFor({ patterns: ['nomatch_*'] }), [],
        'a glob that matches nothing grants nothing');
});

test('W5/tools-unenforceable: a child that cannot enforce the scope fails closed', async () => {
    const client = {
        provider: 'openai',
        /** @param {string} model */
        session(model) {
            const s = {
                provider: 'openai',
                model,
                withSystemMessage() { return s; },
                withTools() { return s; },
                withRetryPolicy() { return s; },
                withHeaderTimeout() { return s; },
                withMaxElapsedMs() { return s; },
                withApproval() { return s; },
                withBudget() { return s; },
                withCircuitBreaker() { return s; },
                async run() { return 'should not run'; },
            };
            return s;
        },
    };
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = parentSession({ client });
    await assert.rejects(
        () => /** @type {any} */ (createTaskTool({ session })).execute({
            args: { prompt: 'Do X', subagent_type: 'worker', handoff: { tools: ['manage_todos'] } },
        }),
        /handoff\.tools is set/,
        'the restriction is never silently skipped',
    );
});

test('W5/tools-explicit: an allowlisted profile tool travels as a tool object, not a name', async () => {
    const { client } = await delegate({
        handoff: { tools: ['manage_todos'] },
        profile: { tools: [{ name: 'manage_todos', description: 'tasks', parameters: {} }] },
    });
    assert.equal(client.toolCalls.length, 1, 'the explicit belt is set');
    assert.equal(client.toolCalls[0][0]?.name, 'manage_todos', 'the object survives, not a bare string');
});

test('W5/tools-glob: a glob in the allowlist selects the matching profile tools', async () => {
    const { client } = await delegate({
        handoff: { tools: ['my_*'] },
        profile: { tools: [{ name: 'my_tool', description: 'x', parameters: {} }] },
    });
    assert.deepEqual(client.allowlists[0], ['my_*']);
    assert.equal(client.toolCalls[0]?.[0]?.name, 'my_tool', 'the glob reaches the tool object');
});

test('W5/full-cross-provider: a degraded full replay is visible, never silent', async () => {
    const parent = makeClient('openai');
    const other = makeClient('anthropic');
    withTaskAgents({ client: parent, agents: [{ name: 'worker', model: 'm', client: other }] });
    const session = parentSession({ client: parent, last: [U, A, B] });
    /** @type {any[]} */
    const degradations = [];
    session.eventEmitter.on('task:fork_degraded', (/** @type {any} */ e) => degradations.push(e));
    await /** @type {any} */ (createTaskTool({ session })).execute({
        args: { prompt: 'Do X', subagent_type: 'worker', handoff: { context: 'full', goal: 'clean' } },
    });
    const input = other.runs[0];
    const text = joined(input);
    assert.equal(input.length, 4, 'three degraded parent units + the brief');
    assert.ok(text.includes('[Output from'), 'foreign-wire units degrade to digest rows');
    assert.equal(degradations.length, 1, 'the degradation is announced');
});

test('W5/tools-guard-order: the scope guard fires before capability inheritance', async () => {
    const bareClient = {
        provider: 'openai',
        /** @param {string} model */
        session(model) {
            const s = {
                provider: 'openai',
                model,
                withSystemMessage() { return s; },
                withTools() { return s; },
                withRetryPolicy() { return s; },
                withHeaderTimeout() { return s; },
                withMaxElapsedMs() { return s; },
                withApproval() { return s; },
                withBudget() { return s; },
                withCircuitBreaker() { return s; },
                async run() { return 'should not run'; },
            };
            return s;
        },
    };
    withTaskAgents({ client: bareClient, agents: [{ name: 'worker', model: 'm' }] });
    // A real capability component on the parent, so inheritance WOULD run and
    // call the missing withCapability if the guard were ordered after it.
    const real = new OaiChatSession({ client: bareClient, model: 'm', eventEmitter: new EventEmitter() });
    real.withTodos({ store: new Map() });
    const parent = parentSession({ client: bareClient });
    parent._todoComponent = real._todoComponent;
    parent._todoPreload = true;
    await assert.rejects(
        () => /** @type {any} */ (createTaskTool({ session: parent })).execute({
            args: { prompt: 'Do X', subagent_type: 'worker', handoff: { tools: ['manage_todos'] } },
        }),
        /handoff\.tools is set/,
        'the intended ConfigurationError, not a withCapability TypeError',
    );
});

test('W5/degraded-same-provider: a degraded unit within one backend is announced', async () => {
    const client = makeClient('openai');
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = parentSession({ client, last: [
        { role: 'tool', tool_call_id: 't1', content: 'orphan result' },
        { role: 'assistant', content: 'answer' },
    ] });
    /** @type {any[]} */
    const degradations = [];
    session.eventEmitter.on('task:fork_degraded', (/** @type {any} */ e) => degradations.push(e));
    await /** @type {any} */ (createTaskTool({ session })).execute({
        args: { prompt: 'Do X', subagent_type: 'worker', handoff: { context: 'fork', goal: 'clean' } },
    });
    assert.equal(degradations.length, 1, 'a same-backend degradation is not silent');
    assert.ok(joined(client.runs[0]).includes('[Output from'), 'the dangling unit is a visible digest row');
});

test('W5/tools-nested: a delegated child inherits the allowlist', async () => {
    const { captureSessionPolicy, applySessionPolicy } = await import('../lib/agentic/session-policy.mjs');
    const make = () => {
        const session = new OaiChatSession({
            client: { chat: { completions: { create: async () => { throw new Error('no transport in this check'); } } } },
            model: 'm',
            eventEmitter: new EventEmitter(),
        });
        session.withTodos({ store: new Map() });
        return session;
    };
    const parent = make();
    parent.withPermissions({ allow: [], deny: [] });
    parent.withToolAllowlist({ patterns: ['manage_*'] });
    const policy = captureSessionPolicy({ session: parent });
    parent.withToolAllowlist({ patterns: null });
    assert.deepEqual((parent._tools ?? []).map((/** @type {any} */ t) => t.name), ['manage_todos'], 'null patterns add no layer');
    const child = make();
    applySessionPolicy({ session: child, policy });
    assert.deepEqual((child._tools ?? []).map((/** @type {any} */ t) => t.name), ['manage_todos'],
        'the inherited layer filters the child');

    // A grandchild may narrow, never widen: a second layer must also admit the tool.
    // `load_todos` is mounted but outside the inherited `manage_*` layer.
    const names = () => (child._tools ?? []).map((/** @type {any} */ t) => t.name).sort();
    child.withToolAllowlist({ patterns: ['manage_todos', 'load_todos'] });
    assert.deepEqual(names(), ['manage_todos'], 'an explicit grandchild list cannot add load_todos');
    child.withToolAllowlist({ patterns: ['load_todos'] });
    assert.deepEqual(names(), [], 'a disjoint request grants nothing');
});

test('W5/tools-nested-wiring: the delegation path carries the allowlist to the child', async () => {
    const { client } = await delegate({ parentLayers: [['manage_*']] });
    assert.deepEqual(client.sessions[0]._toolAllowlists, [['manage_*']], 'the policy carrier runs on every child');
});

test('W5/tools-plan: the plan-agent tool branch obeys the allowlist layers too', () => {
    const session = new OaiChatSession({
        client: { chat: { completions: { create: async () => { throw new Error('no transport in this check'); } } } },
        model: 'm',
        eventEmitter: new EventEmitter(),
    });
    session.withTodos({ store: new Map() });
    session.withPlan({});
    session.withToolAllowlist({ patterns: ['manage_todos'] });
    assert.deepEqual((session._tools ?? []).map((/** @type {any} */ t) => t.name), ['manage_todos'],
        'the plan branch is filtered');
    session.withToolAllowlist({ patterns: ['load_todos'] });
    assert.deepEqual((session._tools ?? []).map((/** @type {any} */ t) => t.name), [],
        'a disjoint layer closes the plan branch');
});
