// @ts-check

/**
 * Wave 6 / SP5 — the client is a transport (D2).
 *
 * Check-first: written against the post-SP4 tree, where SP1's registry is the
 * source of truth but the client still carries a compatibility view
 * (`_taskAgents`, `_taskClients`, `_taskClientResolver`, `_taskMaxDepth`,
 * `_taskCounter`, `_backgroundTasks`, `_agentDelegation`) as accessors. SP5
 * removes that view: the client owns no orchestration state, and a host that
 * presets a legacy field gets it adopted ONCE (with a deprecation notice) and
 * deleted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
    withTaskAgents, withAgentDelegation, createTaskTool, resolveDelegationMaxDepth,
    normalizeDelegationEnvelope,
} from '../lib/agentic/task.mjs';
import { getSpawnRegistry, listSpawns } from '../lib/agentic/spawn-registry.mjs';
import { resolveAgentClient } from '../lib/agentic/task.mjs';
import { log } from '../lib/support/utils.mjs';

const LEGACY = [
    '_taskAgents', '_taskClients', '_taskClientResolver', '_taskMaxDepth',
    '_taskCounter', '_backgroundTasks', '_agentDelegation',
];

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
                _lastRunUsage: null,
                withSystemMessage() { return s; },
                withTools() { return s; },
                withRetryPolicy() { return s; },
                withHeaderTimeout() { return s; },
                withMaxElapsedMs() { return s; },
                withApproval() { return s; },
                withBudget() { return s; },
                withCircuitBreaker() { return s; },
                withPermissions() { return s; },
                withToolAllowlist() { return s; },
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

/** @param {any} client @returns {string[]} */
function leakedFields(client) {
    return LEGACY.filter((name) => name in client);
}

// ─── Nothing is installed on the client ────────────────────────────────────

test('W6T/no-client-fields: registration leaves no orchestration field on the client', () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    withAgentDelegation({ client, maxDepth: 2 });
    assert.deepEqual(leakedFields(client), [], 'none of the seven legacy fields exists, own or inherited');
    const registry = getSpawnRegistry({ client });
    assert.ok(registry.agents.has('explore'), 'the roster lives in the registry');
    assert.equal(registry.delegation?.maxDepth, 2, 'the envelope lives in the registry');
});

test('W6T/registry-state: clients, resolver, depth, counter and background map live in the registry', () => {
    const client = makeClient();
    const other = makeClient('anthropic');
    withTaskAgents({
        client,
        agents: [{ name: 'explore', model: 'm' }],
        options: { clients: { anthropic: other }, resolveClient: () => other, maxDepth: 3 },
    });
    const registry = getSpawnRegistry({ client });
    assert.equal(registry.clients.get('anthropic'), other);
    assert.equal(typeof registry.resolver, 'function');
    assert.equal(registry.maxDepth, 3);
    assert.equal(registry.counter, 0);
    assert.ok(registry.background instanceof Map);
});

test('W6T/no-fields-after-use: spawning, background work and continuing add nothing to the client', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    const session = parentSession(client);
    const tool = /** @type {any} */ (createTaskTool({ session }));
    await tool.execute({ args: { prompt: 'Do X', subagent_type: 'explore' } });
    await tool.execute({ args: { prompt: 'Do Y', subagent_type: 'explore', background: true } });
    const [spawn] = listSpawns({ client });
    await spawn.continueWith({ prompt: 'Again.' });
    assert.deepEqual(leakedFields(client), [], 'the client is still only a transport');
    assert.ok(getSpawnRegistry({ client }).spawns.size >= 1, 'the registry did the work');
});

test('W6T/transport-shape: the client keeps exactly the fields it had before the SDK touched it', async () => {
    const client = makeClient();
    const before = Object.keys(client).sort();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    await /** @type {any} */ (taskTool(client)).execute({ args: { prompt: 'Do X', subagent_type: 'explore' } });
    const added = Object.keys(client).sort().filter((k) => !before.includes(k));
    assert.deepEqual(added, [], 'no key was added at all');
});

// ─── The legacy preset is adopted once, loudly, and deleted ────────────────

test('W6T/legacy-adopted: a preset legacy field is taken over and removed from the client', async () => {
    const client = makeClient();
    /** @type {any} */
    const preset = { name: 'legacy', model: 'm' };
    client._taskAgents = new Map([['legacy', preset]]);
    client._taskMaxDepth = 4;
    client._backgroundTasks = new Map();
    client._taskCounter = 7;
    const registry = getSpawnRegistry({ client });
    assert.ok(registry.agents.has('legacy'), 'the roster was adopted');
    assert.equal(registry.maxDepth, 4);
    assert.equal(registry.counter, 7, 'a used counter keeps counting');
    assert.deepEqual(leakedFields(client), [], 'and the fields are gone');
    assert.deepEqual(registry.legacyAdopted.sort(), ['_backgroundTasks', '_taskAgents', '_taskCounter', '_taskMaxDepth']);
    // The adopted roster is really used: the tool resolves the profile and an
    // unknown name is refused against that same menu.
    const tool = /** @type {any} */ (taskTool(client));
    await tool.execute({ args: { prompt: 'Do X', subagent_type: 'legacy' } });
    assert.equal(listSpawns({ client })[0].agent, 'legacy');
    await assert.rejects(
        () => tool.execute({ args: { prompt: 'Do X', subagent_type: 'nobody' } }),
        /unknown subagent_type "nobody"/,
    );
});

test('W6T/legacy-warns: adopting a legacy field says so once', () => {
    /** @type {string[]} */
    const lines = [];
    const previous = log._sink;
    log.configure({ sink: {
        log: (/** @type {string} */ t) => lines.push(String(t)),
        error: (/** @type {string} */ t) => lines.push(String(t)),
        write: (/** @type {string} */ t) => lines.push(String(t)),
    } });
    try {
        const client = makeClient();
        client._taskAgents = new Map([['legacy', { name: 'legacy', model: 'm' }]]);
        getSpawnRegistry({ client });
        getSpawnRegistry({ client });
    } finally {
        log.configure({ sink: previous });
    }
    const warnings = lines.filter((l) => /deprecated/i.test(l));
    assert.equal(warnings.length, 1, 'one notice, not one per field or per read');
    assert.match(warnings[0], /_taskAgents/, 'and it names what it adopted');
});

test('W6T/frozen-client: a frozen client cannot hold state and does not need to', async () => {
    const client = Object.freeze(makeClient());
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    assert.deepEqual(leakedFields(client), []);
    assert.ok(getSpawnRegistry({ client }).agents.has('explore'));
    const result = await /** @type {any} */ (taskTool(client)).execute({ args: { prompt: 'Do X', subagent_type: 'explore' } });
    assert.equal(result, 'child answer');
});

// ─── Behaviour the registry must keep ─────────────────────────────────────

test('W6T/background-ids: the counter is per registry, so two clients never collide', async () => {
    const a = makeClient();
    const b = makeClient();
    for (const client of [a, b]) {
        withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
        const tool = /** @type {any} */ (taskTool(client));
        // A foreground spawn must not consume a background id.
        await tool.execute({ args: { prompt: 'Sync', subagent_type: 'explore' } });
        const handle = await tool.execute({
            args: { prompt: 'Do X', subagent_type: 'explore', background: true },
        });
        assert.match(String(handle), /id: task_1\b/, 'the first background call of this registry is task_1');
    }
    assert.equal(getSpawnRegistry({ client: a }).counter, 1);
    assert.equal(getSpawnRegistry({ client: b }).counter, 1);
    await Promise.all(listSpawns({ client: a }).map((s) => s.wait()));
    assert.equal(getSpawnRegistry({ client: a }).background.size, 0, 'the settled background entry is released');
});

test('W6T/session-roster-wins: a session-local roster still takes precedence', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'client-agent', model: 'm' }] });
    const session = parentSession(client);
    session._taskAgents = new Map([['session-agent', { name: 'session-agent', model: 'm' }]]);
    const tool = /** @type {any} */ (createTaskTool({ session }));
    return tool.execute({ args: { prompt: 'Do X', subagent_type: 'client-agent' } })
        .then(() => { throw new Error('the client roster must not be used'); }, (/** @type {any} */ err) => {
            assert.match(err.message, /unknown subagent_type "client-agent"/, 'the session roster is the menu');
            return tool.execute({ args: { prompt: 'Do X', subagent_type: 'session-agent' } });
        })
        .then((/** @type {any} */ result) => { assert.equal(result, 'child answer', 'and the session profile runs'); });
});

test('W6T/null-client: registry reads without a client stay safe and empty', () => {
    const registry = getSpawnRegistry();
    assert.equal(registry.agents.size, 0, 'a throwaway registry, not a crash');
    assert.deepEqual(listSpawns({ client: null }), [], 'and no spawns');
    assert.equal(normalizeDelegationEnvelope({ client: null }).maxDepth, 1, 'the default cap still resolves');
});

test('W6T/routing-from-registry: a profile is routed through the registry’s transport map', () => {
    const client = makeClient();
    const other = makeClient('anthropic');
    withTaskAgents({
        client,
        agents: [{ name: 'explore', model: 'm', provider: 'anthropic' }],
        options: { clients: { anthropic: other } },
    });
    const owner = resolveAgentClient({ parent: client, agent: { provider: 'anthropic' } });
    assert.equal(owner, other, 'the registered transport is used');
    // Without a registration the call fails loudly, never on the wrong wire.
    const bare = makeClient();
    assert.throws(() => resolveAgentClient({ parent: bare, agent: { provider: 'anthropic' } }), /no registered client/);
});

test('W6T/can-delegate-from-registry: the tool is advertised from the registry roster', async () => {
    const { ChatSession } = await import('../lib/backends/oai.mjs');
    const client = makeClient();
    const session = new ChatSession({ client, model: 'm', eventEmitter: client });
    assert.equal(session._canDelegate(), false, 'no roster, no task tool');
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    const later = new ChatSession({ client, model: 'm', eventEmitter: client });
    assert.equal(later._canDelegate(), true, 'the client registry advertises the tool');
    // The roster text the model sees comes from the same registry.
    const tool = /** @type {any} */ (/** @type {any} */ (later._capabilityTools.get('task'))?.[0]);
    const annotated = later._withTaskRoster({ list: [tool] });
    assert.match(String(annotated[0].description), /explore/, 'the model is told which profiles exist');
});

test('W6T/depth-from-registry: the depth cap is read from the registry, not the client', () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }], options: { maxDepth: 3 } });
    const registry = getSpawnRegistry({ client });
    assert.equal(resolveDelegationMaxDepth({ session: parentSession(client) }), 3);
    // The advertised envelope reads the same cap (the tool's description and its
    // call must agree).
    assert.equal(normalizeDelegationEnvelope({ client }).maxDepth, 3, 'the envelope advertises the registry cap');
    registry.maxDepth = 1;
    assert.equal(resolveDelegationMaxDepth({ session: parentSession(client) }), 1, 'a later change is honoured');
    assert.equal(normalizeDelegationEnvelope({ client }).maxDepth, 1, 'and the advertisement follows');
});
