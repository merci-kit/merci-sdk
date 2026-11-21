// @ts-check
/**
 * Example 27 — The spawning contract: roster, envelope, depth, tree, identity.
 *
 * A deterministic core plus a live model scene. The delegation surface is
 * exercised end-to-end with **code-agent** profiles (`execute`), which run host
 * code instead of a model turn, so every rule below is checked against the real
 * registry, the real tool and the real guards:
 *
 *   A — the roster + the envelope : the tool's schema IS the envelope — a
 *       dimension the host did not grant is absent, a forced argument is refused
 *       (fail-closed), and a roster array is the whole menu.
 *   B — depth and the tree        : depth is 1 by default; `maxDepth: 2` lets a
 *       child spawn a grandchild; a per-tree `maxSpawns` caps the tree; a second
 *       root keeps its own budget.
 *   C — a spawn is an identity    : every delegation opens a record with an id,
 *       a parent, a lineage, a status and a handle; a code agent has no
 *       conversation, so it has no durable thread and cannot be forked.
 *   L — the live spawn            : a real parent model is forced to delegate
 *       once through the `task` tool to a named model child; the child's marker
 *       reaches the parent, the spawn record keeps its identity, and the depth
 *       and tree caps refuse the next spawn without a model call.
 *
 * Public API: `withTaskAgents`, `withAgentDelegation`, `createTaskTool`,
 * `listSpawns`, `getSpawn`, `spawnThreadId`, `forkSpawn`, `ConfigurationError`.
 *
 * Run: `node test/examples/27_spawning_contract.mjs` (live) · `node test/examples/27_spawning_contract.mjs --offline` (deterministic)
 * Needs: `BACKEND` + provider credentials in `secret.env` for the live scene;
 *        `--offline` needs none.
 *
 * @version 0.12.0
 */
import { EventEmitter } from 'node:events';
import {
    ConfigurationError, EVENTS, createTaskTool, forkSpawn, getSpawn, initializeClient, listSpawns, loadCredentials, log,
    spawnThreadId, withAgentDelegation, withTaskAgents,
} from 'merci-sdk';
import { createAudit } from '../../examples/_shared/example-audit.mjs';
import { reportUsage, resolveExample, trackUsage, wireClient } from '../../examples/_shared/example-utils.mjs';

const OFFLINE = process.argv.includes('--offline');
const live = OFFLINE ? null : resolveExample();

const audit = createAudit({
    metaUrl: import.meta.url,
    id: 'audit/27_spawning_contract',
    offline: OFFLINE,
    provider: live?.provider ?? null,
    models: live ? live.toolModel : null,
    title: 'Example 27 — The spawning contract',
});

/**
 * A client stand-in: the spawn registry is keyed by this object, and a code-agent
 * profile needs no transport. A real host passes `client.session(model)`; the
 * `task` tool only needs `client`, `model`, `backend` and the event emitter.
 * @returns {any}
 */
function makeClient() {
    const client = /** @type {any} */ (new EventEmitter());
    client.provider = 'offline';
    return client;
}

/**
 * The session-shaped object the tool runs from.
 * @param {{client: any, sessionId?: string, depth?: number}} arg0
 * @returns {any}
 */
function makeParent({ client, sessionId = 'root-1', depth = 0 } = /** @type {any} */ ({})) {
    return {
        client,
        model: 'offline-model',
        provider: 'offline',
        eventEmitter: client,
        sessionId,
        _taskDepth: depth,
        _lastStepMessages: [],
    };
}

/** @param {string} name @returns {any} */
const codeAgent = (name) => ({
    name,
    description: `the ${name} role`,
    /** @param {{prompt: string}} arg0 */
    execute: async ({ prompt }) => `${name} handled: ${prompt}`,
});

/** @param {{tool: any, args: any}} arg0 */
async function run({ tool, args }) {
    try {
        return { ok: true, value: await tool.execute({ args }) };
    } catch (err) {
        return { ok: false, error: err };
    }
}

/** @param {any} err @returns {string} */
const messageOf = (err) => String(err?.message ?? err);

async function main() {
    log.option({
        name: 'mode',
        value: live ? `live (${live.provider})` : 'offline',
        source: live
            ? 'a real model parent and child for scene L; scenes A–C stay code-agent deterministic'
            : 'code-agent profiles — no model, no network, no stdin',
    });

    /** @type {Awaited<ReturnType<typeof initializeClient>>['client']|null} */
    let client = null;
    /** @type {ReturnType<typeof trackUsage>|null} */
    let usage = null;
    let apiCalls = 0;
    if (live !== null) {
        const initialized = await initializeClient({
            provider: live.provider,
            options: loadCredentials({ provider: live.provider }),
        });
        client = initialized.client;
        wireClient({ client });
        usage = trackUsage({ client });
        client.on('api_request', () => { apiCalls += 1; });
    }

    // ── A: the roster and the envelope ───────────────────────────────────────
    audit.scenario({
        id: 'A', title: 'the roster and the envelope',
        goal: 'the tool schema is exactly what the host granted, and an ungranted dimension fails closed',
        expect: 'before the grant: no model/system/tools keys · a forced model → ConfigurationError · after the grant: the keys appear and the spawn runs · a roster array hides the profiles it does not name',
        fails: [
            { code: 'schema-leak', symptom: 'model/system/tools appear without a grant', hint: 'the schema is derived from normalizeDelegationEnvelope — a dimension is absent unless granted' },
            { code: 'fail-open', symptom: 'a forced ungranted model ran', hint: 'execute() must refuse an ungranted dimension, not ignore it' },
            { code: 'roster-ignored', symptom: 'a profile outside the declared array was accepted', hint: 'an agents array IS the menu' },
        ],
        input: { profiles: ['analyst', 'writer'], granted: ['models', 'system', 'tools'] },
    });

    const closedClient = makeClient();
    withTaskAgents({ client: closedClient, agents: [codeAgent('analyst'), codeAgent('writer')] });
    const closedParent = makeParent({ client: closedClient });
    const closedTool = /** @type {any} */ (createTaskTool({ session: closedParent }));
    const closedKeys = Object.keys(closedTool.parameters.properties).sort();
    audit.observe({ name: 'schema before the grant', value: closedKeys });
    audit.check({
        name: 'an ungranted dimension is absent from the schema',
        ok: !closedKeys.includes('model') && !closedKeys.includes('system') && !closedKeys.includes('tools'),
        detail: { expected: 'no model/system/tools', observed: closedKeys.join(', ') },
    });
    const forced = await run({ tool: closedTool, args: { prompt: 'hi', subagent_type: 'analyst', model: 'sneaky-model' } });
    audit.check({
        name: 'a forced ungranted dimension is refused (fail-closed)',
        ok: forced.ok === false && forced.error instanceof ConfigurationError,
        detail: { expected: 'ConfigurationError', observed: forced.ok ? 'ran' : messageOf(forced.error) },
    });

    withAgentDelegation({ client: closedClient, models: 'any', system: 'any', tools: 'inherit' });
    const grantedTool = /** @type {any} */ (createTaskTool({ session: closedParent }));
    const grantedKeys = Object.keys(grantedTool.parameters.properties).sort();
    audit.observe({ name: 'schema after the grant', value: grantedKeys });
    audit.check({
        name: 'a granted dimension appears in the schema',
        ok: ['model', 'system', 'tools'].every((k) => grantedKeys.includes(k)),
        detail: { expected: 'model, system, tools present', observed: grantedKeys.join(', ') },
    });
    const grantedRun = await run({ tool: grantedTool, args: { prompt: 'hi', subagent_type: 'analyst', system: 'THIS SPAWN: be brief.' } });
    audit.check({
        // A code agent has no system prompt, so this proves the ARGUMENT is accepted
        // once granted; an LLM child appends it after the role template (§4 of the doc).
        name: 'a granted per-spawn adaptation is accepted',
        ok: grantedRun.ok === true && grantedRun.value === 'analyst handled: hi',
        detail: { expected: 'analyst handled: hi', observed: grantedRun.ok ? grantedRun.value : messageOf(grantedRun.error) },
    });

    const menuClient = makeClient();
    // Both profiles are registered; the ENVELOPE's array is the narrower menu, so
    // the registry alone must not be enough to spawn `writer`.
    withTaskAgents({ client: menuClient, agents: [codeAgent('analyst'), codeAgent('writer')] });
    withAgentDelegation({ client: menuClient, agents: [codeAgent('analyst')] });
    const menuTool = /** @type {any} */ (createTaskTool({ session: makeParent({ client: menuClient }) }));
    const offMenu = await run({ tool: menuTool, args: { prompt: 'hi', subagent_type: 'writer' } });
    audit.check({
        name: 'a roster array is the whole menu, even over a larger registry',
        ok: offMenu.ok === false && /unknown subagent_type "writer"/.test(messageOf(offMenu.error)),
        detail: { expected: 'writer refused', observed: offMenu.ok ? 'ran' : messageOf(offMenu.error) },
    });
    const onMenu = await run({ tool: menuTool, args: { prompt: 'hi', subagent_type: 'analyst' } });
    audit.check({
        name: 'a profile inside the declared array still runs',
        ok: onMenu.ok === true,
        detail: { expected: 'analyst handled: hi', observed: onMenu.ok ? onMenu.value : messageOf(onMenu.error) },
    });
    audit.end();

    // ── B: depth and the tree ────────────────────────────────────────────────
    audit.scenario({
        id: 'B', title: 'depth and the tree',
        goal: 'depth is 1 by default, maxDepth lets a child spawn, and a per-tree spawn cap stops a fan-out',
        expect: 'default: one code run then a depth-limit refusal · maxDepth 2: two runs · maxSpawns 2: the third spawn in the tree refused, another root unaffected',
        fails: [
            { code: 'depth-ignored', symptom: 'the recursive code agent kept running', hint: 'a code agent runs inside a frame at its spawn depth (E1)' },
            { code: 'no-depth-2', symptom: 'maxDepth 2 still refused the grandchild', hint: 'the envelope raises the cap; the session cap is a ceiling' },
            { code: 'tree-unbounded', symptom: 'the third spawn ran', hint: 'maxSpawns counts every spawn of the tree, nested ones included' },
        ],
        input: { maxDepth: 2, maxSpawns: 2 },
    });

    const depthClient = makeClient();
    /** @type {string[]} */
    const runs = [];
    /** @type {any} */
    let depthTool = null;
    const recursive = {
        name: 'recursive',
        description: 'a code agent that spawns itself',
        /** @param {{prompt: string}} arg0 */
        execute: async ({ prompt }) => {
            runs.push(prompt);
            if (runs.length < 4) {
                try { await depthTool.execute({ args: { prompt: `${prompt} >`, subagent_type: 'recursive' } }); }
                catch { /* the cap is the point */ }
            }
            return `run ${runs.length}`;
        },
    };
    withTaskAgents({ client: depthClient, agents: [recursive] });
    const depthParent = makeParent({ client: depthClient });
    depthTool = createTaskTool({ session: depthParent });
    await depthTool.execute({ args: { prompt: 'level 1', subagent_type: 'recursive' } });
    audit.observe({ name: 'runs at the default depth', value: runs.length });
    audit.check({
        name: 'the default depth stops a recursive code agent at one level',
        ok: runs.length === 1,
        detail: { expected: '1 run', observed: `${runs.length} run(s)` },
    });

    const depth2Client = makeClient();
    /** @type {string[]} */
    const runs2 = [];
    /** @type {any} */
    let depth2Tool = null;
    const recursive2 = {
        name: 'recursive',
        description: 'a code agent that spawns itself',
        /** @param {{prompt: string}} arg0 */
        execute: async ({ prompt }) => {
            runs2.push(prompt);
            if (runs2.length < 4) {
                try { await depth2Tool.execute({ args: { prompt: `${prompt} >`, subagent_type: 'recursive' } }); }
                catch { /* the cap is the point */ }
            }
            return `run ${runs2.length}`;
        },
    };
    withTaskAgents({ client: depth2Client, agents: [recursive2] });
    withAgentDelegation({ client: depth2Client, maxDepth: 2 });
    const depth2Parent = makeParent({ client: depth2Client });
    depth2Tool = createTaskTool({ session: depth2Parent });
    await depth2Tool.execute({ args: { prompt: 'level 1', subagent_type: 'recursive' } });
    audit.observe({ name: 'runs at maxDepth 2', value: runs2.length });
    audit.check({
        name: 'maxDepth 2 lets the child spawn a grandchild',
        ok: runs2.length === 2,
        detail: { expected: '2 runs', observed: `${runs2.length} run(s)` },
    });

    const treeClient = makeClient();
    withTaskAgents({ client: treeClient, agents: [codeAgent('analyst')] });
    withAgentDelegation({ client: treeClient, maxSpawns: 2 });
    const treeParent = makeParent({ client: treeClient });
    const treeTool = /** @type {any} */ (createTaskTool({ session: treeParent }));
    await treeTool.execute({ args: { prompt: 'one', subagent_type: 'analyst' } });
    await treeTool.execute({ args: { prompt: 'two', subagent_type: 'analyst' } });
    const third = await run({ tool: treeTool, args: { prompt: 'three', subagent_type: 'analyst' } });
    audit.check({
        name: 'a per-tree spawn cap refuses the third spawn',
        ok: third.ok === false && /spawn tree limit reached \(2\)/.test(messageOf(third.error)),
        detail: { expected: 'spawn tree limit reached (2)', observed: third.ok ? 'ran' : messageOf(third.error) },
    });
    const otherRoot = makeParent({ client: treeClient, sessionId: 'root-2' });
    const otherTool = /** @type {any} */ (createTaskTool({ session: otherRoot }));
    const otherRun = await run({ tool: otherTool, args: { prompt: 'other tree', subagent_type: 'analyst' } });
    audit.check({
        name: 'another root keeps its own tree budget',
        ok: otherRun.ok === true,
        detail: { expected: 'ran', observed: otherRun.ok ? otherRun.value : messageOf(otherRun.error) },
    });
    audit.end();

    // ── C: a spawn is an identity ────────────────────────────────────────────
    audit.scenario({
        id: 'C', title: 'a spawn is an identity',
        goal: 'every delegation is recorded with an id, a lineage and a status, and a code agent has no conversation to fork',
        expect: 'listSpawns → records with ids and lineage · getSpawn finds one · the code-agent handle has threadId null · forkSpawn refuses "no conversation to fork"',
        fails: [
            { code: 'unrecorded', symptom: 'no spawn record after a delegation', hint: 'openSpawn runs before the work starts' },
            { code: 'phantom-thread', symptom: 'a code agent reports a threadId', hint: 'a code agent builds no child session, so it has no thread' },
            { code: 'fork-silent', symptom: 'forkSpawn returned without forking', hint: 'a session-less spawn must be refused explicitly' },
        ],
        input: { agents: ['analyst'] },
    });

    const identityClient = makeClient();
    withTaskAgents({ client: identityClient, agents: [codeAgent('analyst')] });
    const identityParent = makeParent({ client: identityClient });
    const identityTool = /** @type {any} */ (createTaskTool({ session: identityParent }));
    await identityTool.execute({ args: { prompt: 'record me', subagent_type: 'analyst' } });
    const handles = listSpawns({ client: identityClient });
    const handle = handles[0];
    audit.observe({ name: 'the spawn record', value: { id: handle?.id, parentId: handle?.parentId, lineage: handle?.lineage, status: handle?.status } });
    audit.check({
        name: 'the delegation is recorded with an id, a parent and a lineage',
        ok: Boolean(handle?.id) && handle.parentId === 'root-1' && Array.isArray(handle.lineage) && handle.lineage.includes('root-1'),
        detail: { expected: 'id + parent root-1 + lineage', observed: JSON.stringify({ id: handle?.id, parentId: handle?.parentId, lineage: handle?.lineage }) },
    });
    audit.check({
        name: 'getSpawn reads the same record back',
        ok: Boolean(handle?.id) && getSpawn({ client: identityClient, id: handle.id })?.id === handle.id,
        detail: { expected: handle?.id, observed: getSpawn({ client: identityClient, id: String(handle?.id) })?.id },
    });
    audit.check({
        name: 'a code agent has no durable thread',
        ok: (handle?.threadId ?? null) === null,
        detail: { expected: 'null', observed: String(handle?.threadId) },
    });
    /** @type {any} */
    let forkError = null;
    try {
        await forkSpawn({ client: identityClient, id: handle?.id, newThreadId: 'branch-1' });
    } catch (err) {
        forkError = err;
    }
    audit.check({
        name: 'forking a session-less spawn is refused explicitly',
        ok: forkError instanceof ConfigurationError && /no conversation to fork/.test(messageOf(forkError)),
        detail: { expected: 'no conversation to fork', observed: messageOf(forkError) },
    });
    audit.check({
        name: 'the durable thread name is deterministic from the spawn id',
        ok: spawnThreadId({ id: 'sub_demo' }) === 'spawn:sub_demo',
        detail: { expected: 'spawn:sub_demo', observed: spawnThreadId({ id: 'sub_demo' }) },
    });
    audit.end();

    // ── L: the live spawn ────────────────────────────────────────────────────
    if (client !== null && live !== null) {
        const AGENT = 'marker';
        const MARKER = 'RELAY-LIVE-27';
        audit.scenario({
            id: 'L', title: 'the live spawn',
            goal: 'a real parent model delegates once through the task tool to a named model child and relays its marker',
            expect: 'at least one api_request · exactly one task start, subagent_type marker · the child answer is RELAY-LIVE-27 and the parent relays it · the spawn record names its parent and lineage · the tree cap refuses a second spawn and the depth cap a nested one',
            fails: [
                { code: 'no-api', symptom: 'no api_request was emitted', hint: 'the parent and child must run real model turns' },
                { code: 'no-task', symptom: 'the parent never called the task tool with subagent_type marker', hint: 'the roster must grant marker and the prompt must force one delegation; do not fake the tool call' },
                { code: 'marker-lost', symptom: 'the child result or the parent answer lacks RELAY-LIVE-27', hint: 'the child role prompt returns the literal marker and the parent must relay it' },
                { code: 'identity-lost', symptom: 'the spawn record lacks its agent, parent or lineage', hint: 'openSpawn runs before the work starts' },
                { code: 'cap-open', symptom: 'a second spawn or a nested spawn ran', hint: 'maxDepth 1 and maxSpawns 1 must refuse before any model call' },
            ],
            input: { agent: AGENT, marker: MARKER, model: live.defaultModel, childModel: live.toolModel, maxDepth: 1, maxSpawns: 1 },
        });

        withTaskAgents({ client: /** @type {any} */ (client), agents: [{
            name: AGENT,
            model: live.toolModel,
            systemPrompt: `You are a marker relay. Reply with exactly ${MARKER} and nothing else.`,
        }] });
        withAgentDelegation({ client: /** @type {any} */ (client), maxDepth: 1, maxSpawns: 1 });

        /** @type {string[]} */
        const taskAgents = [];
        /** @type {string[]} */
        const toolCalls = [];
        client.on(EVENTS.TASK.START, (/** @type {any} */ e) => { if (e?.subagent_type) taskAgents.push(String(e.subagent_type)); });
        const parent = client.session(live.defaultModel)
            .withSystemMessage('You delegate. Use the task tool; never do the delegated work yourself.');
        const answer = await parent.run({
            initialInput: `Call the task tool exactly once with subagent_type "${AGENT}" and prompt "Announce the marker." Then reply with exactly the subagent's answer and nothing else.`,
            options: {
                maxIterations: 6,
                onEvent: (/** @type {{type?: string, name?: string}} */ event) => {
                    if (event?.type === 'tool_call_start') toolCalls.push(String(event.name));
                },
            },
        });
        const answerText = String(answer ?? '');
        const spawned = listSpawns({ client: /** @type {any} */ (client) }).find((h) => h.agent === AGENT) ?? null;
        audit.observe({ name: 'live answer', value: answerText });
        audit.observe({ name: 'live task starts', value: taskAgents });
        audit.observe({ name: 'live tool calls', value: toolCalls });
        audit.observe({
            name: 'spawn record',
            value: spawned ? { id: spawned.id, parentId: spawned.parentId, lineage: spawned.lineage, agent: spawned.agent, status: spawned.status } : null,
        });
        audit.check({
            name: 'the live run made real vendor calls',
            ok: apiCalls > 0,
            detail: { expected: '> 0 api_request', observed: `${apiCalls} api_request` },
        });
        audit.check({
            name: 'the parent called the task tool exactly once with the named subagent',
            ok: toolCalls.includes('task') && taskAgents.length === 1 && taskAgents[0] === AGENT,
            detail: { expected: `task tool · one start with ${AGENT}`, observed: `${toolCalls.join(', ') || '(no tool)'} · ${taskAgents.join(', ') || '(none)'}` },
        });
        audit.check({
            name: 'the subagent answer is the marker and the parent relays it',
            ok: String(spawned?.result ?? '').includes(MARKER) && answerText.includes(MARKER),
            detail: { expected: MARKER, observed: `child=${String(spawned?.result ?? '').trim()} · parent=${answerText.trim()}` },
        });
        audit.check({
            name: 'the spawn record keeps its agent, parent and lineage',
            ok: Boolean(spawned?.id) && spawned?.status === 'done'
                && spawned?.agent === AGENT
                && spawned?.parentId === parent.sessionId
                && JSON.stringify(spawned?.lineage) === JSON.stringify([parent.sessionId, spawned?.id]),
            detail: {
                expected: `agent ${AGENT} · parent ${parent.sessionId} · lineage [parent, id]`,
                observed: JSON.stringify(spawned ? { agent: spawned.agent, parentId: spawned.parentId, lineage: spawned.lineage, status: spawned.status } : null),
            },
        });
        const second = await run({ tool: /** @type {any} */ (createTaskTool({ session: /** @type {any} */ (parent) })), args: { prompt: 'again', subagent_type: AGENT } });
        audit.check({
            name: 'the tree cap refuses a second spawn without a model call',
            ok: second.ok === false && /spawn tree limit reached \(1\)/.test(messageOf(second.error)),
            detail: { expected: 'spawn tree limit reached (1)', observed: second.ok ? 'ran' : messageOf(second.error) },
        });
        const nested = spawned?.session
            ? await run({ tool: /** @type {any} */ (createTaskTool({ session: /** @type {any} */ (spawned.session) })), args: { prompt: 'deeper', subagent_type: AGENT } })
            : { ok: false, error: new Error('the live spawn kept no child session') };
        audit.check({
            name: 'the depth cap refuses a nested spawn without a model call',
            ok: nested.ok === false && /depth limit reached \(1\)/.test(messageOf(nested.error)),
            detail: { expected: 'subagent depth limit reached (1)', observed: nested.ok ? 'ran' : messageOf(nested.error) },
        });
        audit.end();
    }

    if (live !== null && usage !== null) reportUsage({ provider: live.provider, usage });
    log.success({ m: 'Spawning contract verified: roster, envelope, depth, tree, identity.' });
}

// The await matters: without it the run is not a top-level await, and a
// stalled round would exit 0 with a truncated log instead of failing.
await audit.run(main);
