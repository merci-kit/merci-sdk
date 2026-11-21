// @ts-check

/**
 * Wave 6 / SP7 — nesting depth 2+ bounded by the tree (D9).
 *
 * The contract: depth stays **1 by default**; the delegation envelope may raise
 * it; and the *tree* is what is bounded — by a per-tree spawn cap and the shared
 * budget pool (SP4), not by a fixed depth. The audit's E1 is fixed here too: a
 * code-agent (`execute`) profile used to bypass the depth counter entirely
 * because it never builds a child session, so a recursive profile recursed
 * without the cap the LLM path enforces.
 *
 * These checks were written against the pre-SP7 tree (10 of the final 20 failed
 * there). The oracle is the sessions the engine actually builds and the spawn
 * records it actually writes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
    withTaskAgents, withAgentDelegation, createTaskTool, normalizeDelegationEnvelope, runTaskChild,
} from '../lib/agentic/task.mjs';
import { getSpawnRegistry, listSpawns } from '../lib/agentic/spawn-registry.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';

/**
 * A client whose `session()` returns a session usable as a parent too, so a
 * nested spawn can be driven exactly as the model would drive it.
 * @param {string} provider
 * @returns {any}
 */
function makeClient(provider = 'openai') {
    /** @type {any[]} */
    const sessions = [];
    /** @type {any} */
    let api;
    /** @param {string} [model] @returns {any} */
    function childSession(model = 'child-model') {
        const s = {
            // A child must be a client-bearing session: a nested spawn resolves
            // the roster through `session.client`, exactly as a real one does.
            client: api,
            provider,
            model,
            eventEmitter: new EventEmitter(),
            /** @type {any} */
            _toolAllowlists: null,
            /** @type {any} */
            _system: '',
            /** @type {any} */
            _toolsStore: [],
            /** @param {any} m */
            withSystemMessage(m) {
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
    }
    api = {
        provider,
        sessions,
        /** @param {string} [model] */
        session(model) { return childSession(model); },
        /** @param {{model?: string}} [arg0] */
        sessionWithId({ model } = {}) { return childSession(model); },
    };
    return api;
}

/**
 * @param {any} client
 * @param {{sessionId?: string, depth?: number}} [options]
 * @returns {any}
 */
function rootSession(client, { sessionId = 'root-1', depth = 0 } = {}) {
    return {
        client,
        model: 'parent-model',
        provider: client.provider,
        eventEmitter: new EventEmitter(),
        sessionId,
        _taskDepth: depth,
        _lastStepMessages: [],
    };
}

/** @param {any} session @param {string} agent @param {string} prompt @param {any} [extra] */
async function spawn(session, agent, prompt, extra = {}) {
    const tool = /** @type {any} */ (createTaskTool({ session }));
    return tool.execute({ args: { prompt, subagent_type: agent, ...extra } });
}

const ONE_AGENT = [{ name: 'worker', model: 'child-model' }];

// ─── Depth 2+ works, and the cap still stops it ────────────────────────────

test('W6D/nested-depth-2: a child may spawn a grandchild when the envelope allows depth 2', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    withAgentDelegation({ client, maxDepth: 2 });
    const root = rootSession(client);
    await spawn(root, 'worker', 'level one');
    const child = client.sessions.at(-1);
    assert.equal(child._taskDepth, 1, 'the child starts one level down');
    const out = await spawn(child, 'worker', 'level two');
    assert.equal(out, 'child answer');
    const grandchild = client.sessions.at(-1);
    assert.notEqual(grandchild, child);
    assert.equal(grandchild._taskDepth, 2, 'the grandchild is two levels down');
    const records = listSpawns({ client });
    const grandRecord = records.find((/** @type {any} */ r) => r.id === grandchild._spawnId);
    assert.ok(grandRecord, 'the grandchild has a spawn record');
    assert.equal(grandRecord.lineage.length, 3, 'the public lineage is the whole chain: root, child, this spawn');
});

test('W6D/depth-cap: a session already at the cap is refused, with the cap in the message', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    withAgentDelegation({ client, maxDepth: 2 });
    const atCap = rootSession(client, { depth: 2 });
    await assert.rejects(
        () => spawn(atCap, 'worker', 'too deep'),
        (/** @type {any} */ err) => /depth limit reached \(2\)/.test(err.message),
    );
    assert.equal(client.sessions.length, 0, 'no session was built');
});

test('W6D/default-depth: without an envelope the default is still one level', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    const child = rootSession(client, { depth: 1 });
    await assert.rejects(
        () => spawn(child, 'worker', 'not allowed'),
        (/** @type {any} */ err) => /depth limit reached \(1\)/.test(err.message),
    );
});

test('W6D/lineage-parent: the grandchild hangs off the child spawn, not off the root', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    withAgentDelegation({ client, maxDepth: 2 });
    const root = rootSession(client);
    await spawn(root, 'worker', 'level one');
    const child = client.sessions.at(-1);
    await spawn(child, 'worker', 'level two');
    const grandchild = client.sessions.at(-1);
    const records = listSpawns({ client });
    const childRecord = records.find((/** @type {any} */ r) => r.id === child._spawnId);
    const grandRecord = records.find((/** @type {any} */ r) => r.id === grandchild._spawnId);
    assert.ok(childRecord && grandRecord, 'both spawn records exist');
    assert.equal(grandRecord.parentId, childRecord.id, 'parentId is the spawn that asked');
    assert.deepEqual(grandRecord.lineage, ['root-1', childRecord.id, grandRecord.id], 'the chain runs root -> child -> grandchild');
});

test('W6D/direct-depth: a direct runTaskChild call is capped too, not only the tool', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    withAgentDelegation({ client, maxDepth: 1 });
    const child = rootSession(client, { depth: 1 });
    await assert.rejects(
        async () => runTaskChild({
            session: child,
            profile: /** @type {any} */ (ONE_AGENT[0]),
            args: /** @type {any} */ ({ prompt: 'direct' }),
            signal: undefined,
            eventEmitter: new EventEmitter(),
        }),
        (/** @type {any} */ err) => /depth limit reached \(1\)/.test(err.message),
    );
});

// ─── E1: the code-agent path counts toward the depth ───────────────────────

/** @param {any} client @param {number} maxDepth @param {number} levels */
function recursiveCodeProfile(client, maxDepth, levels = 5) {
    /** @type {number[]} */
    const attempts = [];
    /** @type {string[]} */
    const refusals = [];
    /** @type {any} */
    let tool = null;
    /** @type {any} */
    let parent = null;
    const profile = {
        name: 'coder',
        model: 'child-model',
        /** @param {{prompt: string}} arg0 */
        execute: async ({ prompt }) => {
            attempts.push(parent._taskDepth ?? 0);
            if (attempts.length < levels) {
                try {
                    await tool.execute({ args: { prompt: `${prompt} >`, subagent_type: 'coder' } });
                } catch (err) {
                    refusals.push(/** @type {any} */ (err).message);
                }
            }
            return 'code done';
        },
    };
    return {
        attempts,
        refusals,
        /** @param {any} session */
        bind(session) {
            parent = session;
            tool = /** @type {any} */ (createTaskTool({ session }));
            return profile;
        },
    };
}

test('W6D/code-depth-1: a recursive execute profile stops at the default cap (E1)', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    withAgentDelegation({ client, maxDepth: 1 });
    const root = rootSession(client);
    const run = recursiveCodeProfile(client, 1);
    const profile = run.bind(root);
    withTaskAgents({ client, agents: [profile] });
    const out = await spawn(root, 'coder', 'start');
    assert.equal(out, 'code done');
    assert.equal(run.attempts.length, 1, 'the code agent ran exactly once');
    assert.equal(run.refusals.length, 1, 'the recursive call was refused');
    assert.match(run.refusals[0], /depth limit reached \(1\)/);
});

test('W6D/code-depth-2: with depth 2 the recursion reaches level 2 and no further', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    withAgentDelegation({ client, maxDepth: 2 });
    const root = rootSession(client);
    const run = recursiveCodeProfile(client, 2);
    const profile = run.bind(root);
    withTaskAgents({ client, agents: [profile] });
    await spawn(root, 'coder', 'start');
    assert.equal(run.attempts.length, 2, 'two levels ran, the third was refused');
    assert.match(run.refusals[0], /depth limit reached \(2\)/);
});

test('W6D/code-depth-restored: the held depth is released when the code agent settles', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    withAgentDelegation({ client, maxDepth: 2 });
    const root = rootSession(client);
    const run = recursiveCodeProfile(client, 2, 1);
    const profile = run.bind(root);
    const before = Object.keys(root);
    withTaskAgents({ client, agents: [profile] });
    await spawn(root, 'coder', 'start');
    assert.equal(root._taskDepth, 0, 'the parent is back at its own depth');
    assert.equal(root._taskDepthHolds, undefined, 'no hold field is left behind');
    assert.deepEqual(Object.keys(root).filter((k) => k !== '_spawnTree').sort(), before.sort(),
        'the frame left no trace on the parent (only the tree stamp is new)');
});

// ─── The frames: siblings and concurrency (the verifier's F1/F2) ───────────

test('W6D/code-siblings: two code children from one code agent both run at depth 2', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    withAgentDelegation({ client, maxDepth: 2 });
    const root = rootSession(client);
    /** @type {number[]} */
    const attempts = [];
    /** @type {any} */
    let tool = null;
    const profile = {
        name: 'coder',
        model: 'child-model',
        execute: async () => {
            attempts.push(root._taskDepth ?? 0);
            if (attempts.length === 1) {
                await tool.execute({ args: { prompt: 'a', subagent_type: 'coder' } });
                await tool.execute({ args: { prompt: 'b', subagent_type: 'coder' } });
            }
            return 'ok';
        },
    };
    tool = createTaskTool({ session: root });
    withTaskAgents({ client, agents: [profile, { name: 'worker', model: 'child-model' }] });
    await spawn(root, 'coder', 'parent');
    assert.equal(attempts.length, 3, 'the parent and both siblings ran');
    assert.equal(root._taskDepth, 0, 'the parent was never mutated');
    await spawn(root, 'worker', 'after');
    assert.equal(client.sessions.at(-1)._taskDepth, 1, 'a later LLM child still starts at depth 1 (no frame leak)');
});

test('W6D/code-concurrent: concurrent code spawns do not borrow each other depth', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    withAgentDelegation({ client, maxDepth: 2 });
    const root = rootSession(client);
    /** @type {any} */
    let tool = null;
    const profile = {
        name: 'coder',
        model: 'child-model',
        execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return 'ok';
        },
    };
    tool = createTaskTool({ session: root });
    withTaskAgents({ client, agents: [profile] });
    const results = await Promise.all([
        tool.execute({ args: { prompt: 'a', subagent_type: 'coder' } }),
        tool.execute({ args: { prompt: 'b', subagent_type: 'coder' } }),
    ]);
    assert.deepEqual(results, ['ok', 'ok'], 'both concurrent code spawns ran');
    assert.equal(root._taskDepth, 0);
    await spawn(root, 'worker', 'after');
    assert.equal(client.sessions.at(-1)._taskDepth, 1, 'a later LLM child still starts at depth 1 (no frame leak)');
});

// ─── The per-tree cap ──────────────────────────────────────────────────────

test('W6D/tree-cap-direct: a direct runTaskChild call is tree-capped too', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    withAgentDelegation({ client, maxDepth: 2, maxSpawns: 1 });
    const root = rootSession(client);
    root._spawnTree = { root: 'root-1', count: 1 };
    await assert.rejects(
        async () => runTaskChild({
            session: root,
            profile: /** @type {any} */ (ONE_AGENT[0]),
            args: /** @type {any} */ ({ prompt: 'direct' }),
            signal: undefined,
            eventEmitter: new EventEmitter(),
        }),
        (/** @type {any} */ err) => /spawn tree limit reached \(1\)/.test(err.message),
    );
});

test('W6D/tree-cap-failures: a spawn that fails still counts against the tree', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [
        { name: 'boom', model: 'child-model', /** @param {{prompt: string}} arg0 */ execute: async () => { throw new Error('boom'); } },
        { name: 'worker', model: 'child-model' },
    ] });
    withAgentDelegation({ client, maxDepth: 2, maxSpawns: 2 });
    const root = rootSession(client);
    await assert.rejects(() => spawn(root, 'boom', 'fails'), /boom/);
    await spawn(root, 'worker', 'second');
    await assert.rejects(
        () => spawn(root, 'worker', 'third'),
        (/** @type {any} */ err) => /spawn tree limit reached \(2\)/.test(err.message),
    );
});

test('W6D/maa-tree: a discussion shares one tree across its stages', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{
        name: 'worker',
        /** @param {{prompt: string}} arg0 */
        execute: async ({ prompt }) => `did ${prompt}`,
    }] });
    withAgentDelegation({ client, maxSpawns: 1 });
    const group = new DiscussionSession({ client: /** @type {any} */ (client) });
    group.addAgent({ name: 'Analyst', persona: 'Analyze.', model: 'm', provider: 'openai' });
    const stage = (/** @type {string} */ title) => ({
        title,
        description: `Work on ${title}`,
        assignee: 'Analyst',
        subagent_type: 'worker',
    });
    await group.runTasks({ tasks: [stage('one')] });
    await group.runTasks({ tasks: [stage('two')] });
    const ledger = /** @type {any} */ (group.getLedger());
    const entries = ledger.map((/** @type {any} */ e) => String(e.content)).join('\n');
    assert.match(entries, /did Work on one/, 'the first stage ran');
    assert.match(entries, /spawn tree limit reached \(1\)/, 'the second stage hit the SAME tree cap');
});

test('W6D/tree-cap: the third spawn in a two-spawn tree is refused, naming the cap', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    withAgentDelegation({ client, maxDepth: 2, maxSpawns: 2 });
    const root = rootSession(client);
    await spawn(root, 'worker', 'one');
    await spawn(root, 'worker', 'two');
    await assert.rejects(
        () => spawn(root, 'worker', 'three'),
        (/** @type {any} */ err) => /spawn tree limit reached \(2\)/.test(err.message),
    );
});

test('W6D/tree-cap-nested: grandchildren count against the same tree, not against a new one', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    withAgentDelegation({ client, maxDepth: 2, maxSpawns: 2 });
    const root = rootSession(client);
    await spawn(root, 'worker', 'one');
    const child = client.sessions.at(-1);
    await spawn(child, 'worker', 'two (grandchild)');
    await assert.rejects(
        () => spawn(root, 'worker', 'three'),
        (/** @type {any} */ err) => /spawn tree limit reached \(2\)/.test(err.message),
    );
});

test('W6D/tree-cap-separate: another root has its own budget', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    withAgentDelegation({ client, maxDepth: 2, maxSpawns: 1 });
    const first = rootSession(client, { sessionId: 'root-1' });
    await spawn(first, 'worker', 'one');
    const second = rootSession(client, { sessionId: 'root-2' });
    const out = await spawn(second, 'worker', 'other tree');
    assert.equal(out, 'child answer', 'the second tree is unaffected');
});

test('W6D/tree-cap-transport: a grandchild on another transport counts in the same tree', async () => {
    const openai = makeClient('openai');
    const other = makeClient('anthropic');
    withTaskAgents({
        client: openai,
        agents: ONE_AGENT,
        options: { clients: { openai, anthropic: other } },
    });
    withAgentDelegation({ client: openai, maxDepth: 2, maxSpawns: 2, transports: 'any' });
    const root = rootSession(openai);
    await spawn(root, 'worker', 'one');
    const child = openai.sessions.at(-1);
    // The grandchild is routed to the other transport client.
    await spawn(child, 'worker', 'two', { provider: 'anthropic' });
    assert.equal(other.sessions.length, 1, 'the grandchild ran on the other transport');
    await assert.rejects(
        () => spawn(root, 'worker', 'three'),
        (/** @type {any} */ err) => /spawn tree limit reached \(2\)/.test(err.message),
    );
});

test('W6D/long-tree: forty sequential spawns fit under the default cap', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    const root = rootSession(client);
    for (let i = 0; i < 40; i++) {
        const out = await spawn(root, 'worker', `step ${i}`);
        assert.equal(out, 'child answer');
    }
    assert.equal(client.sessions.length, 40, 'every step ran');
});

test('W6D/host-direct-depth-0: a host depth-0 direct call is not killed by maxDepth 0', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: ONE_AGENT });
    withAgentDelegation({ client, maxDepth: 0 });
    const root = rootSession(client);
    const out = await runTaskChild({
        session: root,
        profile: /** @type {any} */ (ONE_AGENT[0]),
        args: /** @type {any} */ ({ prompt: 'host call' }),
        signal: undefined,
        eventEmitter: new EventEmitter(),
    });
    assert.equal(out, 'child answer', 'the planner/host path still works');
});

test('W6D/envelope-validation: maxSpawns must be a non-negative number', () => {
    const client = makeClient();
    assert.throws(
        () => withAgentDelegation({ client, maxSpawns: -1 }),
        (/** @type {any} */ err) => /maxSpawns must be a non-negative number/.test(err.message),
    );
    assert.throws(
        () => withAgentDelegation({ client, maxSpawns: Number.NaN }),
        (/** @type {any} */ err) => /maxSpawns must be a non-negative number/.test(err.message),
    );
});

test('W6D/tree-cap-default: the envelope carries a finite default and the guard reads it', async () => {
    const client = makeClient();
    const env = normalizeDelegationEnvelope({ client });
    assert.equal(env.maxSpawns, 128, 'a tree is bounded by default, not only when the host says so');
    withTaskAgents({ client, agents: ONE_AGENT });
    const root = rootSession(client);
    root._spawnTree = { root: 'root-1', count: 128 };
    await assert.rejects(
        () => spawn(root, 'worker', 'over the default'),
        (/** @type {any} */ err) => /spawn tree limit reached \(128\)/.test(err.message),
    );
});
