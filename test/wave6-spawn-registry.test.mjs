// @ts-check

/**
 * Wave 6 / SP1 — the spawn registry and orchestration state off the client.
 *
 * Check-first: written before the registry exists. The registry is the source of
 * truth; the client properties are a compatibility view. A spawn carries identity
 * (id, parentId, lineage), a status, its session and its own usage ledger.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
    withTaskAgents, createTaskTool,
} from '../lib/agentic/task.mjs';
import {
    getSpawnRegistry, listSpawns, getSpawn, openSpawn, adoptSpawnIdentity, finishSpawn, failSpawn,
} from '../lib/agentic/spawn-registry.mjs';

/** @returns {any} */
function makeClient() {
    /** @type {any[]} */
    const sessions = [];
    return {
        provider: 'openai',
        sessions,
        /** @param {string} model */
        session(model) {
            const s = {
                provider: 'openai',
                model,
                /** @type {any} */
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
                async run() {
                    s._lastRunUsage = { promptTokens: 11, completionTokens: 4 };
                    return 'child answer';
                },
            };
            sessions.push(s);
            return s;
        },
    };
}

/** @param {any} client @returns {any} */
const parentSession = (client) => ({
    client,
    model: 'parent-model',
    provider: client.provider,
    eventEmitter: new EventEmitter(),
    _taskDepth: 0,
    _lastStepMessages: [],
});

// ─── The registry owns the orchestration state ──────────────────────────────

test('W6/registry-source: the registry owns the roster, not the client object', () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    const registry = getSpawnRegistry({ client });
    assert.ok(registry.agents.has('explore'), 'the roster lives in the registry');
    // SP5 superseded the compatibility view: the client is a transport and
    // carries no field at all (see wave6-transport.test.mjs).
    assert.equal('_taskAgents' in client, false, 'the client carries no roster field');
});

test('W6/registry-isolation: two clients never share spawn state', () => {
    const a = makeClient();
    const b = makeClient();
    withTaskAgents({ client: a, agents: [{ name: 'one', model: 'm' }] });
    withTaskAgents({ client: b, agents: [{ name: 'two', model: 'm' }] });
    assert.ok(getSpawnRegistry({ client: a }).agents.has('one'));
    assert.ok(!getSpawnRegistry({ client: a }).agents.has('two'));
    const record = openSpawn({ registry: getSpawnRegistry({ client: a }), agent: 'one' });
    assert.equal(listSpawns({ client: a }).length, 1);
    assert.equal(listSpawns({ client: b }).length, 0);
    assert.ok(getSpawn({ client: a, id: record.id }));
    assert.equal(getSpawn({ client: b, id: record.id }), null);
});

test('W6/registry-envelope: the delegation envelope lives in the registry too', async () => {
    const { withAgentDelegation } = await import('../lib/agentic/task.mjs');
    const client = makeClient();
    withAgentDelegation({ client, models: 'any' });
    assert.equal(getSpawnRegistry({ client }).delegation?.models, 'any');
    assert.equal('_agentDelegation' in client, false, 'the envelope lives in the registry only');
});

// ─── A spawn has identity ───────────────────────────────────────────────────

test('W6/spawn-identity: a foreground spawn records id, parent, lineage, status, model and backend', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'child-model' }] });
    const parent = parentSession(client);
    parent.sessionId = 'ses_parent';
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({
        args: { prompt: 'Do X', subagent_type: 'explore' },
    });
    const spawns = listSpawns({ client });
    assert.equal(spawns.length, 1, 'one spawn recorded');
    const spawn = spawns[0];
    assert.match(spawn.id, /^sub_/, 'a spawn id');
    assert.equal(spawn.parentId, 'ses_parent', 'the parent conversation id');
    assert.deepEqual(spawn.lineage, ['ses_parent', spawn.id], 'the lineage is root → self');
    assert.equal(spawn.status, 'done');
    assert.equal(spawn.agent, 'explore');
    assert.equal(spawn.model, 'child-model');
    assert.equal(spawn.provider, 'openai');
    assert.equal(spawn.result, 'child answer');
});

test('W6/spawn-usage: a spawn carries its own usage ledger', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    await /** @type {any} */ (createTaskTool({ session: parentSession(client) })).execute({
        args: { prompt: 'Do X', subagent_type: 'explore' },
    });
    const [spawn] = listSpawns({ client });
    assert.deepEqual(spawn.usage, { promptTokens: 11, completionTokens: 4 },
        'the child session usage is the spawn ledger');
});

test('W6/spawn-lineage: a nested spawn extends the lineage and names its parent spawn', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }], options: { maxDepth: 3 } });
    // The child session the engine builds must carry the identity for a nested call.
    const parent = parentSession(client);
    parent.sessionId = 'ses_root';
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({
        args: { prompt: 'Do X', subagent_type: 'explore' },
    });
    const [first] = listSpawns({ client });
    assert.equal(first.parentId, 'ses_root');

    const childSession = client.sessions[0];
    assert.equal(childSession._spawnId, first.id, 'the child session is stamped with its spawn id');
    assert.deepEqual(childSession._spawnLineage, ['ses_root', first.id]);
});

test('W6/spawn-error: a failed spawn records the status and the message', async () => {
    const client = makeClient();
    client.session = (/** @type {string} */ model) => {
        const s = {
            provider: 'openai',
            model,
            _lastRunUsage: { promptTokens: 3 },
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
            async run() { throw new Error('upstream exploded'); },
        };
        return s;
    };
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    await assert.rejects(() => /** @type {any} */ (createTaskTool({ session: parentSession(client) })).execute({
        args: { prompt: 'Do X', subagent_type: 'explore' },
    }));
    const [spawn] = listSpawns({ client });
    assert.equal(spawn.status, 'error');
    assert.match(String(spawn.error), /upstream exploded/);
});

test('W6/spawn-background: a background spawn is running, then done, and wait() resolves', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    const parent = parentSession(client);
    await /** @type {any} */ (createTaskTool({ session: parent })).execute({
        args: { prompt: 'Do X', subagent_type: 'explore', background: true },
    });
    const [spawn] = listSpawns({ client });
    assert.equal(spawn.status, 'running', 'the handle exists before the work finishes');
    assert.equal(await spawn.wait(), 'child answer', 'wait() settles on the result');
    const settled = getSpawn({ client, id: spawn.id });
    assert.equal(settled?.status, 'done');
    assert.equal(settled?.result, 'child answer');
});

// ─── The primitives are usable on their own (SP3 will build continueWith) ───

test('W6/registry-primitives: open/adopt/finish/fail are the one implementation', () => {
    const client = makeClient();
    const registry = getSpawnRegistry({ client });
    const parent = { sessionId: 'ses_a', _spawnLineage: [] };
    const record = openSpawn({ registry, parent, agent: 'one', model: 'mm', provider: 'openai' });
    assert.equal(record.status, 'running');
    /** @type {any} */
    const session = { model: 'mm', _lastRunUsage: { promptTokens: 2 } };
    adoptSpawnIdentity({ session, record });
    assert.equal(session._spawnId, record.id);
    finishSpawn({ record, result: 'ok' });
    assert.equal(record.status, 'done');
    assert.deepEqual(record.usage, { promptTokens: 2 });

    const other = openSpawn({ registry, agent: 'two' });
    failSpawn({ record: other, error: new Error('nope') });
    assert.equal(other.status, 'error');
    assert.equal(other.error, 'nope');
    assert.equal(listSpawns({ client }).length, 2);
    assert.equal(listSpawns({ client, status: 'error' }).length, 1, 'filterable by status');
});

// ─── Findings from the independent SP1 verifier ─────────────────────────────

test('W6/compat-preset: a host that preset a client field keeps its data', () => {
    const client = makeClient();
    client._taskAgents = new Map([['direct', { name: 'direct', model: 'dm' }]]);
    client._taskClients = new Map([['anthropic', { provider: 'anthropic' }]]);
    client._taskCounter = 41;
    withTaskAgents({ client, agents: [{ name: 'added', model: 'm' }] });
    const registry = getSpawnRegistry({ client });
    assert.ok(registry.agents.has('direct'), 'the preset roster migrated');
    assert.ok(registry.agents.has('added'), 'the new roster was added');
    assert.deepEqual(registry.legacyAdopted.sort(), ['_taskAgents', '_taskClients', '_taskCounter'], 'the preset fields were adopted');
    assert.equal('_taskAgents' in client, false, 'and removed from the client (SP5)');
    assert.ok(registry.clients.has('anthropic'), 'the preset transport registry migrated');
    assert.equal(registry.counter, 41, 'the preset counter migrated');
});

test('W6/lineage-no-duplicate: a nested spawn names its parent id exactly once', () => {
    const client = makeClient();
    const registry = getSpawnRegistry({ client });
    const root = { sessionId: 'ses_root' };
    const first = openSpawn({ registry, parent: root, agent: 'a' });
    const childSession = adoptSpawnIdentity({ session: {}, record: first });
    const second = openSpawn({ registry, parent: childSession, agent: 'b' });
    assert.deepEqual(second.lineage, ['ses_root', first.id], 'no duplicate parent id');
    assert.equal(second.parentId, first.id, 'the parent is the spawn, not the conversation');
    const grandSession = /** @type {any} */ (adoptSpawnIdentity({ session: {}, record: second }));
    assert.deepEqual(grandSession._spawnLineage, ['ses_root', first.id, second.id]);
});

test('W6/usage-sum: a retried spawn reports the spend of every attempt', async () => {
    const client = makeClient();
    client.session = (/** @type {string} */ model) => {
        const primary = model === 'primary';
        /** @type {any} */
        const spend = { promptTokens: primary ? 100 : 5 };
        /** @type {any} */
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
            withToolAllowlist() { return s; },
            async run() {
                if (primary) throw Object.assign(new Error('transient'), { status: 503 });
                return 'fallback answer';
            },
        };
        // The step engine resets `_lastRunUsage` to null; a real provider reports
        // its spend through it, so the fake keeps the reported value.
        Object.defineProperty(s, '_lastRunUsage', {
            get: () => spend,
            set: () => {},
            configurable: true,
        });
        return s;
    };
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'primary', fallbackModel: 'cheap' }] });
    await /** @type {any} */ (createTaskTool({ session: parentSession(client) })).execute({
        args: { prompt: 'Do X', subagent_type: 'explore' },
    });
    const [spawn] = listSpawns({ client });
    assert.equal(spawn.result, 'fallback answer');
    assert.equal(/** @type {any} */ (spawn.usage)?.promptTokens, 105, 'both attempts are charged');
    assert.equal(spawn.model, 'primary', 'the identity keeps the requested model');
});

test('W6/settle-once: a code-agent spawn settles exactly once', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'coder', execute: async () => 'code-ok' }] });
    await /** @type {any} */ (createTaskTool({ session: parentSession(client) })).execute({
        args: { prompt: 'Do X', subagent_type: 'coder' },
    });
    const [spawn] = listSpawns({ client });
    assert.equal(spawn.status, 'done');
    assert.equal(spawn.result, 'code-ok');
    const finishedAt = spawn.finishedAt;
    assert.ok(finishedAt, 'settled');
    assert.equal(getSpawn({ client, id: spawn.id })?.finishedAt, finishedAt, 'settled once, not re-stamped');
});

test('W6/direct-child: a direct runTaskChild call is recorded too (the MAA path)', async () => {
    const { runTaskChild } = await import('../lib/agentic/task.mjs');
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = parentSession(client);
    const profile = getSpawnRegistry({ client }).agents.get('worker');
    assert.ok(profile);
    const result = await runTaskChild({ session, profile, args: { description: 'x', prompt: 'Do X', subagent_type: 'worker' }, signal: undefined, eventEmitter: session.eventEmitter });
    assert.equal(result, 'child answer');
    const spawns = listSpawns({ client });
    assert.equal(spawns.length, 1, 'the MAA/direct path opens a record');
    assert.equal(spawns[0].status, 'done');
});

test('W6/wait-in-flight: a foreground spawn exposes a promise while it runs', async () => {
    const client = makeClient();
    let release = () => {};
    client.session = (/** @type {string} */ model) => {
        const s = {
            provider: 'openai',
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
            run() { return new Promise((resolve) => { release = () => resolve('late answer'); }); },
        };
        return s;
    };
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    const pending = /** @type {any} */ (createTaskTool({ session: parentSession(client) })).execute({
        args: { prompt: 'Do X', subagent_type: 'explore' },
    });
    await new Promise((r) => setTimeout(r, 10));
    const [spawn] = listSpawns({ client });
    assert.equal(spawn.status, 'running');
    const waited = spawn.wait();
    release();
    assert.equal(await waited, 'late answer', 'wait() resolves for a foreground spawn');
    assert.equal(await pending, 'late answer');
    assert.equal(getSpawn({ client, id: spawn.id })?.status, 'done', 'the handle status is live');
});

test('W6/retention: settled spawns are capped so a long-lived client does not grow forever', async () => {
    const client = makeClient();
    const registry = getSpawnRegistry({ client });
    for (let i = 0; i < 120; i++) {
        const record = openSpawn({ registry, agent: 'a' });
        finishSpawn({ record, result: i });
    }
    assert.ok(listSpawns({ client }).length <= 100, 'settled records are evicted');
    assert.equal(getSpawn({ client, id: listSpawns({ client })[0].id })?.status, 'done', 'the recent ones survive');
});

test('W6/exported: the registry API is reachable from the package entry', async () => {
    const sdk = /** @type {any} */ (await import('../lib/index.mjs'));
    for (const name of ['getSpawnRegistry', 'listSpawns', 'getSpawn']) {
        assert.equal(typeof sdk[name], 'function', `${name} is exported`);
    }
});

test('W6/usage-hedge: a concurrent hedge charges every attempt it ran', async () => {
    const client = makeClient();
    let built = 0;
    client.session = (/** @type {string} */ model) => {
        built += 1;
        const mine = built;
        const spend = { promptTokens: mine === 1 ? 10 : 3 };
        /** @type {any} */
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
            withToolAllowlist() { return s; },
            async run() {
                // The hedge builds attempt 2 while attempt 1 is still spending.
                // A wide margin keeps the hedge deterministic under a loaded,
                // instrumented suite: the loser must still be asleep when the
                // hedge starts at 5 ms.
                await new Promise((r) => setTimeout(r, mine === 1 ? 250 : 5));
                Object.defineProperty(s, '_lastRunUsage', { value: spend, configurable: true });
                return mine === 2 ? 'hedge winner' : 'slow result';
            },
        };
        return s;
    };
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm', hedgeAfterMs: 5 }] });
    await /** @type {any} */ (createTaskTool({ session: parentSession(client) })).execute({
        args: { prompt: 'Do X', subagent_type: 'explore' },
    });
    // The loser finishes after the winner; the ledger is live, so read once it has.
    // The loser sleeps 250 ms in this fixture, so the wait must outlast it.
    await new Promise((r) => setTimeout(r, 400));
    const [spawn] = listSpawns({ client });
    assert.equal(/** @type {any} */ (spawn.usage)?.promptTokens, 13, 'both hedged attempts are charged');
});

test('W6/lineage-empty: an empty lineage still names its root', () => {
    const client = makeClient();
    const registry = getSpawnRegistry({ client });
    const record = openSpawn({ registry, parent: { sessionId: 'ses_a', _spawnLineage: [] }, agent: 'a' });
    assert.deepEqual(record.lineage, ['ses_a'], 'the root is not dropped');
});

test('W6/hedge-winner: the record keeps the winning attempt\'s session', async () => {
    const client = makeClient();
    /** @type {any[]} */
    const built = [];
    let n = 0;
    client.session = (/** @type {string} */ model) => {
        n += 1;
        const mine = n;
        /** @type {any} */
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
            withToolAllowlist() { return s; },
            async run() {
                await new Promise((r) => setTimeout(r, mine === 1 ? 40 : 5));
                Object.defineProperty(s, '_lastRunUsage', { value: { promptTokens: 1 }, configurable: true });
                return mine === 1 ? 'slow loser' : 'hedge winner';
            },
        };
        built.push(s);
        return s;
    };
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm', hedgeAfterMs: 5 }] });
    await /** @type {any} */ (createTaskTool({ session: parentSession(client) })).execute({
        args: { prompt: 'Do X', subagent_type: 'explore' },
    });
    const [spawn] = listSpawns({ client });
    assert.equal(spawn.result, 'hedge winner');
    assert.equal(spawn.session, built[1], 'the winner is the session a continue would resume');
    assert.notEqual(spawn.session, built[0], 'not the aborted hedge');
});

test('W6/registry-bare-client: getSpawnRegistry accepts the client itself, not a throwaway', () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'explore', model: 'm' }] });
    const record = openSpawn({ registry: getSpawnRegistry({ client }), agent: 'explore' });
    assert.equal(getSpawnRegistry(client).client, client, 'the bare form is bound to the client, not a throwaway');
    assert.ok(getSpawnRegistry(client).spawns.has(record.id), 'and it is not empty');
});
