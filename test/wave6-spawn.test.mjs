// @ts-check

/**
 * Wave 6 / SP2 — the free spawn shape, bounded by the delegation envelope (D1a).
 *
 * Check-first: written against the pre-SP2 tree. The schema checks are expected to
 * fail (the fields do not exist yet); the envelope default and the fail-closed
 * checks are the authority boundary and must hold in both extremes.
 *
 * The oracle is the tool definition the adapter would send (`_tools`), not the
 * module asserting about itself, plus the child session the engine actually builds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
    withTaskAgents, withAgentDelegation, createTaskTool, normalizeDelegationEnvelope, resolveDelegationMaxDepth,
} from '../lib/agentic/task.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';
import { getSpawnRegistry } from '../lib/agentic/spawn-registry.mjs';

/** @param {string} provider @returns {any} */
function makeClient(provider = 'openai') {
    /** @type {any[]} */
    const sessions = [];
    return {
        provider,
        sessions,
        /** @param {string} model */
        session(model) {
            const s = {
                provider,
                model,
                /** @type {any} */
                _toolAllowlists: null,
                /** @type {any} */
                _system: '',
                /** @type {any} */
                _toolsStore: [],
                withSystemMessage(/** @type {any} */ m) {
                    // SP6: the child system may be a block list (template + adaptation).
                    s._system = Array.isArray(m)
                        ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n')
                        : String(m ?? '');
                    return s;
                },
                /** @param {{tools: any}} arg0 */
                withTools({ tools }) { s._toolsStore = tools; return s; },
                withRetryPolicy() { return s; },
                withHeaderTimeout() { return s; },
                withMaxElapsedMs() { return s; },
                withApproval() { return s; },
                withBudget() { return s; },
                withCircuitBreaker() { return s; },
                withPermissions() { return s; },
                /** @param {{patterns?: string[]|null}} [arg0] */
                withToolAllowlist({ patterns = [] } = {}) {
                    s._toolAllowlists = [...(s._toolAllowlists ?? []), patterns];
                    return s;
                },
                async run() { return 'child answer'; },
            };
            sessions.push(s);
            return s;
        },
    };
}

/** @param {any} client @returns {any} */
function parentSession(client) {
    return {
        client,
        model: 'parent-model',
        provider: client.provider,
        eventEmitter: new EventEmitter(),
        _taskDepth: 0,
        _lastStepMessages: [],
    };
}

/** @param {any} client @returns {any} */
const taskTool = (client) => /** @type {any} */ (createTaskTool({ session: parentSession(client) }));
/** @param {any} tool @returns {Record<string, any>} */
const props = (tool) => tool.parameters.properties;
/** @param {any} tool @returns {string[]} */
const required = (tool) => tool.parameters.required ?? [];

// ─── The envelope: normalized, most restrictive by default ──────────────────

test('W6/envelope-default: every dimension defaults to the restrictive end', () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm', description: 'Explore' }] });
    withAgentDelegation({ client });
    const env = normalizeDelegationEnvelope({ client });
    assert.equal(env.agents.mode, 'roster', 'the registered roster is the menu');
    assert.deepEqual(env.agents.names, ['explore']);
    assert.equal(env.models, 'fixed');
    assert.equal(env.transports, 'fixed');
    assert.equal(env.system, 'fixed');
    assert.equal(env.tools, 'fixed');
    assert.equal(env.maxDepth, 1);
});

test('W6/envelope-full: every dimension can be opened independently', () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }], options: { clients: { anthropic: makeClient('anthropic') } } });
    withAgentDelegation({ client, agents: 'any', models: 'any', transports: 'any', system: 'any', tools: 'inherit', maxDepth: 3 });
    const env = normalizeDelegationEnvelope({ client });
    assert.equal(env.agents.mode, 'any');
    assert.equal(env.models, 'any');
    assert.equal(env.transports, 'any');
    assert.equal(env.system, 'any');
    assert.equal(env.tools, 'inherit');
    assert.equal(env.maxDepth, 3);
});

test('W6/envelope-mixed: one dimension open does not open the others', () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    withAgentDelegation({ client, models: 'any' });
    const env = normalizeDelegationEnvelope({ client });
    assert.equal(env.models, 'any');
    assert.equal(env.agents.mode, 'roster');
    assert.equal(env.system, 'fixed');
    assert.equal(env.tools, 'fixed');
});

// ─── The schema is derived from the envelope ────────────────────────────────

test('W6/schema-restricted: an ungranted dimension is ABSENT from the schema', () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm', description: 'Explore' }] });
    withAgentDelegation({ client });
    const tool = taskTool(client);
    assert.ok(props(tool).subagent_type, 'the roster is selectable');
    assert.ok(required(tool).includes('subagent_type'), 'a profile must be named');
    for (const absent of ['model', 'provider', 'system', 'tools']) {
        assert.equal(props(tool)[absent], undefined, `${absent} is not offered`);
    }
});

test('W6/schema-full: a fully free envelope offers every dimension and drops the required profile', () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    withAgentDelegation({ client, agents: 'any', models: 'any', transports: 'any', system: 'any', tools: 'inherit' });
    const tool = taskTool(client);
    for (const present of ['model', 'provider', 'system', 'tools']) {
        assert.ok(props(tool)[present], `${present} is offered`);
    }
    assert.ok(!required(tool).includes('subagent_type'), 'an ad-hoc spawn needs no profile name');
});

test('W6/schema-mixed: the schema follows each dimension independently', () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    withAgentDelegation({ client, models: 'any', tools: 'inherit' });
    const tool = taskTool(client);
    assert.ok(props(tool).model, 'models are free');
    assert.ok(props(tool).tools, 'tools may narrow');
    assert.equal(props(tool).provider, undefined, 'transports stay fixed');
    assert.equal(props(tool).system, undefined, 'the system prompt stays fixed');
    assert.ok(required(tool).includes('subagent_type'), 'the roster stays a menu');
});

// ─── Execution honours the ad-hoc shape ─────────────────────────────────────

test('W6/spawn-adhoc: model, system and tools travel into the child', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [] });
    withAgentDelegation({ client, agents: 'any', models: 'any', system: 'any', tools: 'inherit' });
    const tool = taskTool(client);
    const result = await tool.execute({ args: {
        prompt: 'Analyse this',
        model: 'gpt-5-mini',
        system: 'You are a data analyst.',
        tools: ['read_file'],
    } });
    assert.equal(result, 'child answer');
    const child = client.sessions[0];
    assert.equal(child.model, 'gpt-5-mini', 'the per-spawn model reached the session');
    assert.equal(child._system, 'You are a data analyst.', 'the per-spawn system prompt reached the child');
    assert.deepEqual(child._toolAllowlists, [['read_file']], 'the per-spawn tool list narrowed the child');
});

test('W6/spawn-provider: a granted transport is resolved from the registry', async () => {
    const openai = makeClient('openai');
    const anthropic = makeClient('anthropic');
    withTaskAgents({ client: openai, agents: [], options: { clients: { anthropic } } });
    withAgentDelegation({ client: openai, agents: 'any', transports: 'any', models: 'any' });
    const tool = taskTool(openai);
    await tool.execute({ args: { prompt: 'Do X', provider: 'anthropic', model: 'claude-x' } });
    assert.equal(anthropic.sessions.length, 1, 'the child ran on the chosen transport');
    assert.equal(openai.sessions.length, 0, 'the parent transport was not used');
});

test('W6/spawn-profile-override: a granted dimension overrides the profile', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'cheap-model', systemPrompt: 'Roster prompt.' }] });
    withAgentDelegation({ client, models: 'any', system: 'any' });
    const tool = taskTool(client);
    await tool.execute({ args: { prompt: 'Do X', subagent_type: 'explore', model: 'strong-model', system: 'Ad-hoc prompt.' } });
    const child = client.sessions[0];
    assert.equal(child.model, 'strong-model');
    assert.ok(String(child._system).includes('Ad-hoc prompt.'));
    assert.ok(String(child._system).includes('Roster prompt.'), 'SP6/D11: the per-spawn system ADAPTS the role template, it does not replace it');
});

// ─── Fail closed on an ungranted dimension ─────────────────────────────────

test('W6/fail-closed-model: asking for an ungranted model is rejected, not ignored', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    withAgentDelegation({ client });
    const tool = taskTool(client);
    await assert.rejects(
        () => tool.execute({ args: { prompt: 'Do X', subagent_type: 'explore', model: 'gpt-5' } }),
        /model.*not granted|not granted.*model/i,
        'the envelope is an authority boundary',
    );
    assert.equal(client.sessions.length, 0, 'no child ran');
});

test('W6/fail-closed-system: an ungranted system prompt is rejected', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    withAgentDelegation({ client });
    await assert.rejects(
        () => taskTool(client).execute({ args: { prompt: 'Do X', subagent_type: 'explore', system: 'Override.' } }),
        /system.*not granted|not granted.*system/i,
    );
});

test('W6/fail-closed-provider: an ungranted transport is rejected', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    withAgentDelegation({ client });
    await assert.rejects(
        () => taskTool(client).execute({ args: { prompt: 'Do X', subagent_type: 'explore', provider: 'anthropic' } }),
        /provider.*not granted|not granted.*provider/i,
    );
});

test('W6/fail-closed-tools: an ungranted tool list is rejected', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    withAgentDelegation({ client });
    await assert.rejects(
        () => taskTool(client).execute({ args: { prompt: 'Do X', subagent_type: 'explore', tools: ['read_file'] } }),
        /tools.*not granted|not granted.*tools/i,
    );
});

test('W6/fail-closed-adhoc: a restricted envelope still refuses an unnamed spawn', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    withAgentDelegation({ client });
    await assert.rejects(
        () => taskTool(client).execute({ args: { prompt: 'Do X' } }),
        /subagent_type|profile/i,
        'an ad-hoc spawn needs agents:"any"',
    );
});

test('W6/unknown-profile: an unknown name still fails loudly with the roster', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    withAgentDelegation({ client, agents: 'any' });
    await assert.rejects(
        () => taskTool(client).execute({ args: { prompt: 'Do X', subagent_type: 'nope' } }),
        /unknown subagent_type "nope".*explore/s,
    );
});

// ─── The registry survives without a roster, and the tool stays live ────────

test('W6/schema-live: the schema follows an envelope change after the tool was built', () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    const tool = taskTool(client);
    assert.equal(props(tool).model, undefined, 'restricted at construction');
    withAgentDelegation({ client, models: 'any' });
    assert.ok(props(tool).model, 'the same tool object reflects the new envelope');
});

// ─── Findings from the independent SP2 verifier ─────────────────────────────

test('W6/public-api: withAgentDelegation is reachable from the package entry', async () => {
    const sdk = await import('../lib/index.mjs');
    assert.equal(typeof sdk.withAgentDelegation, 'function', 'a host must be able to declare an envelope');
    assert.equal(typeof sdk.normalizeDelegationEnvelope, 'function');
});

test('W6/free-no-roster: agents:"any" advertises the task tool without a registered profile', async () => {
    const { ChatSession } = await import('../lib/backends/oai.mjs');
    const client = /** @type {any} */ ({
        provider: 'openai',
        chat: { completions: { create: async () => { throw new Error('no transport'); } } },
    });
    withTaskAgents({ client, agents: [] });
    withAgentDelegation({ client, agents: 'any', models: 'any' });
    client.emit = () => false;
    const session = new ChatSession({ client, model: 'm', eventEmitter: client });
    const names = (session._tools ?? []).map((/** @type {any} */ t) => t.name);
    assert.ok(names.includes('task'), 'the ad-hoc shape is available with no roster');
    const tool = /** @type {any} */ (session._tools.find((/** @type {any} */ t) => t.name === 'task'));
    assert.ok(tool.parameters.properties.model, 'the granted model dimension is on the wire schema');
});

test('W6/schema-agents-any: agents:"any" alone does not leak the model dimension', () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [] });
    withAgentDelegation({ client, agents: 'any' });
    const tool = taskTool(client);
    assert.equal(props(tool).model, undefined, 'models stays withheld');
    assert.ok(!required(tool).includes('subagent_type'));
});

test('W6/roster-declared: a declared roster array is the menu, not the whole registry', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [
        { name: 'explore', model: 'em' },
        { name: 'secret', model: 'sm', description: 'Not granted' },
    ] });
    withAgentDelegation({ client, agents: [{ name: 'explore', model: 'em' }] });
    const tool = taskTool(client);
    await assert.rejects(
        () => tool.execute({ args: { prompt: 'Do X', subagent_type: 'secret' } }),
        /unknown subagent_type "secret"/,
        'a role outside the declared array is not selectable',
    );
    assert.equal(client.sessions.length, 0);
    await tool.execute({ args: { prompt: 'Do X', subagent_type: 'explore' } });
    assert.equal(client.sessions.length, 1, 'a declared role still runs');
});

test('W6/tools-registry-safe: a per-spawn tool list never leaks into the registry profile', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    withAgentDelegation({ client, tools: 'inherit' });
    const tool = taskTool(client);
    await tool.execute({ args: { prompt: 'One', subagent_type: 'explore', tools: ['read_file'] } });
    await tool.execute({ args: { prompt: 'Two', subagent_type: 'explore' } });
    assert.deepEqual(client.sessions[0]._toolAllowlists, [['read_file']]);
    assert.equal(client.sessions[1]._toolAllowlists, null, 'the second spawn is unrestricted by the first');
    assert.equal(getSpawnRegistry({ client }).agents.get('explore')?.toolNames, undefined, 'the registry profile is untouched');
});

test('W6/tools-empty-grant: tools:[] denies every tool instead of being ignored', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    withAgentDelegation({ client, tools: 'inherit' });
    await taskTool(client).execute({ args: { prompt: 'Do X', subagent_type: 'explore', tools: [] } });
    assert.deepEqual(client.sessions[0]._toolAllowlists, [[]], 'an empty grant is applied, not skipped');
});

test('W6/tools-fail-closed: a child that cannot enforce tools fails, it does not run unrestricted', async () => {
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
                withPermissions() { return s; },
                async run() { return 'should not run'; },
            };
            return s;
        },
    };
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    withAgentDelegation({ client, tools: 'inherit' });
    await assert.rejects(
        () => taskTool(client).execute({ args: { prompt: 'Do X', subagent_type: 'explore', tools: ['read_file'] } }),
        /tools is set but the child session cannot enforce it/,
    );
});

test('W6/tools-type: a non-array tool grant is rejected', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    withAgentDelegation({ client, tools: 'inherit' });
    await assert.rejects(
        () => taskTool(client).execute({ args: { prompt: 'Do X', subagent_type: 'explore', tools: 'read_file' } }),
        /tools must be an array of tool names/,
    );
});

test('W6/maxdepth-envelope: a declared depth cap is authoritative for the tool and the call', async () => {
    const { ChatSession } = await import('../lib/backends/oai.mjs');
    const build = (/** @type {number} */ maxDepth) => {
        const client = /** @type {any} */ ({
            provider: 'openai',
            chat: { completions: { create: async () => { throw new Error('no transport'); } } },
        });
        withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
        withAgentDelegation({ client, maxDepth });
        client.emit = () => false;
        return new ChatSession({ client, model: 'm', eventEmitter: client });
    };
    const hasTask = (/** @type {any} */ s) => (s._tools ?? []).some((/** @type {any} */ t) => t.name === 'task');

    const deeper = build(3);
    deeper._taskDepth = 2;
    assert.ok(hasTask(deeper), 'maxDepth:3 keeps the tool at depth 2');

    const capped = build(1);
    capped._taskDepth = 1;
    assert.ok(!hasTask(capped), 'the declared cap hides the tool at depth 1');

    const none = build(0);
    assert.ok(!hasTask(none), 'maxDepth:0 means no delegation at all');
});

test('W6/maxdepth-call: the declared cap bounds the call, not just the advertisement', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm', maxDepth: 5 }] });
    withAgentDelegation({ client, maxDepth: 2 });
    const session = parentSession(client);
    session._taskDepth = 2;
    await assert.rejects(
        () => /** @type {any} */ (createTaskTool({ session })).execute({ args: { prompt: 'Do X', subagent_type: 'explore' } }),
        /depth limit reached \(2\)/,
        'the envelope caps a deeper profile',
    );
});

// ─── Findings from the SP2 re-verification ──────────────────────────────────

test('W6/roster-advertised: the description lists only the declared menu', async () => {
    const { ChatSession } = await import('../lib/backends/oai.mjs');
    const client = /** @type {any} */ ({
        provider: 'openai',
        chat: { completions: { create: async () => { throw new Error('no transport'); } } },
    });
    client.emit = () => false;
    withTaskAgents({ client, agents: [
        { name: 'explore', model: 'm', description: 'Declared' },
        { name: 'secret', model: 'sm', description: 'Not granted' },
    ] });
    withAgentDelegation({ client, agents: [{ name: 'explore', model: 'm', description: 'Declared' }] });
    const session = new ChatSession({ client, model: 'm', eventEmitter: client });
    const task = /** @type {any} */ ((session._tools ?? []).find((/** @type {any} */ t) => t.name === 'task'));
    assert.ok(task, 'the tool is advertised');
    assert.ok(String(task.description).includes('explore'), 'the declared role is offered');
    assert.ok(!String(task.description).includes('secret'), 'an undeclared role is not advertised');
});

test('W6/roster-empty: an explicitly empty menu advertises and runs nothing', async () => {
    const { ChatSession } = await import('../lib/backends/oai.mjs');
    const client = /** @type {any} */ ({
        provider: 'openai',
        chat: { completions: { create: async () => { throw new Error('no transport'); } } },
    });
    client.emit = () => false;
    withTaskAgents({ client, agents: [{ name: 'secret', model: 'sm' }] });
    withAgentDelegation({ client, agents: [] });
    const session = new ChatSession({ client, model: 'm', eventEmitter: client });
    assert.ok(!(session._tools ?? []).some((/** @type {any} */ t) => t.name === 'task'), 'no menu, no tool');
    await assert.rejects(
        () => taskTool(client).execute({ args: { prompt: 'Do X', subagent_type: 'secret' } }),
        /unknown subagent_type "secret".*none \(the host grants no subagent profiles\)/s,
        'the wording names the cause, not "call withTaskAgents"',
    );
});

test('W6/tools-host-layer: a per-spawn list intersects a host-set list, never replaces it', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm', toolNames: ['read_file'] }] });
    withAgentDelegation({ client, tools: 'inherit' });
    await taskTool(client).execute({ args: { prompt: 'Do X', subagent_type: 'explore', tools: ['*'] } });
    assert.deepEqual(client.sessions[0]._toolAllowlists, [['read_file'], ['*']],
        'both layers apply, so the host list still bounds the child');
    assert.equal(getSpawnRegistry({ client }).agents.get('explore')?.toolNames?.join(), 'read_file', 'the registry profile keeps its own list');
});

test('W6/maxdepth-consistent: the advertised tool always runs (undeclared envelope keeps the profile cap)', async () => {
    const { ChatSession } = await import('../lib/backends/oai.mjs');
    const client = makeClient();
    client.emit = () => false;
    withTaskAgents({ client, agents: [{ name: 'deep', model: 'm', maxDepth: 5 }] });
    withAgentDelegation({ client, models: 'any' });
    const session = new ChatSession({ client, model: 'm', eventEmitter: client });
    session._taskDepth = 2;
    assert.ok((session._tools ?? []).some((/** @type {any} */ t) => t.name === 'task'),
        'the profile cap still applies when the host named no depth');
    const parent = parentSession(client);
    parent._taskDepth = 2;
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({ args: { prompt: 'Do X', subagent_type: 'deep' } });
    assert.equal(client.sessions.length, 1, 'the offered tool ran');
});

test('W6/maxdepth-session-cap: a tighter session cap bounds a wider declared cap', async () => {
    const { ChatSession } = await import('../lib/backends/oai.mjs');
    const client = /** @type {any} */ ({
        provider: 'openai',
        chat: { completions: { create: async () => { throw new Error('no transport'); } } },
    });
    client.emit = () => false;
    // The profile carries its own wider cap, so only the session cap can bound it.
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm', maxDepth: 5 }] });
    withAgentDelegation({ client, maxDepth: 3 });
    const session = new ChatSession({ client, model: 'm', eventEmitter: client });
    session._taskMaxDepth = 1;
    session._taskDepth = 2;
    assert.ok(!(session._tools ?? []).some((/** @type {any} */ t) => t.name === 'task'),
        'the session cap wins over the wider envelope and the profile');
});

test('W6/maxdepth-session-local: a profile cannot exceed the session-local depth cap', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm', maxDepth: 5 }] });
    // No envelope declares a depth: the session-local cap is the ceiling, not Infinity.
    const session = parentSession(client);
    session._taskMaxDepth = 1;
    const effective = resolveDelegationMaxDepth({
        profile: /** @type {any} */ ({ name: 'explore', maxDepth: 5 }),
        session: /** @type {any} */ (session),
        envelope: null,
    });
    assert.equal(effective, 1, 'the effective cap is the session-local 1, not the profile\'s 5');

    session._taskDepth = 1;
    await assert.rejects(
        () => /** @type {any} */ (createTaskTool({ session })).execute({ args: { prompt: 'Do X', subagent_type: 'explore' } }),
        /depth limit reached \(1\)/,
        'the call is bounded by the same cap',
    );
});

test('W6/unknown-role-menu: the error names the granted menu, not the whole registry', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [
        { name: 'explore', model: 'em' },
        { name: 'secret', model: 'sm', description: 'Not granted' },
    ] });
    withAgentDelegation({ client, agents: [{ name: 'explore', model: 'em' }] });
    await assert.rejects(
        () => taskTool(client).execute({ args: { prompt: 'Do X', subagent_type: 'secret' } }),
        (/** @type {any} */ err) => {
            const menu = String(err.message).split('Available:')[1] ?? '';
            assert.ok(menu.includes('explore'), 'the granted role is listed');
            assert.ok(!menu.includes('secret'), 'the withheld role is not advertised');
            return true;
        },
    );
});
