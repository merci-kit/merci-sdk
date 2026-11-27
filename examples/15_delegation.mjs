// @ts-check
/**
 * Example 15 — Delegation: a lead agent, two specialists, one contract.
 *
 * The lead runs a two-part research brief. Everything about the hand-off is a
 * value the host declared, not a habit of the model:
 *
 *   A — the roster        : `withTaskAgents` registers named profiles (a model
 *       child and a code child). `resolveAgentClient` says which transport a
 *       profile runs on; `TASK_TOOL_NAME` is the front door.
 *   B — the grant         : `withAgentDelegation` declares what the host allows
 *       and `normalizeDelegationEnvelope` reads it back — the tool schema is
 *       derived from the grant, so a withheld dimension is not advertised.
 *   C — one hand-off policy: `AgentContext` + `normalizeHandoff` decide the goal
 *       block (`goalBlockForHandoff`), `merciEnvelope`/`contextFromMerciEnvelope`
 *       carry direction across a peer, and `foldContext`/`compactHistory` are the
 *       same fold every engine uses when a transfer is too long.
 *   D — the delegation   : the lead delegates to both specialists; `listSpawns`
 *       and `getSpawn` read real identities (parent, lineage, thread), and
 *       `sumSpawnUsage` totals what the tree spent.
 *   E — a background spawn: the ack returns at once, then `continueSpawn`,
 *       `sendToSpawn` and `forkSpawn` extend and branch the SAME conversation.
 *   F — the caps         : `maxDepth` and `maxSpawns` close the tree before a
 *       model call, with a typed configuration error.
 *   G — one budget pool  : `getBudgetPool` shows the child drawing from the
 *       lead's ledger — the cap binds the tree, not each session.
 *
 * Public API: `withTaskAgents`, `withAgentDelegation`, `createTaskTool`,
 * `normalizeDelegationEnvelope`, `listSpawns`, `getSpawn`, `forkSpawn`,
 * `continueSpawn`, `sendToSpawn`, `spawnThreadId`, `sumSpawnUsage`,
 * `getBudgetPool`, `AgentContext`, `normalizeHandoff`, `goalBlockForHandoff`,
 * `merciEnvelope`, `contextFromMerciEnvelope`, `foldContext`, `compactHistory`.
 *
 * Run: `node examples/15_delegation.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import {
    AgentContext, ConfigurationError, EVENTS, HANDOFF_CONTEXT_MODES, HANDOFF_GOAL_MODES,
    TASK_TOOL_NAME, compactHistory, contextFromMerciEnvelope, continueSpawn, createTaskTool, foldContext, forkSpawn,
    getBudgetPool, getSpawn, goalBlockForHandoff, initializeClient, listSpawns, loadCredentials, log, merciEnvelope,
    normalizeDelegationEnvelope, normalizeHandoff, resolveAgentClient, sendToSpawn, spawnThreadId, sumSpawnUsage,
    withAgentDelegation, withTaskAgents,
} from 'merci-sdk';
import { InMemorySessionStore } from 'merci-sdk/sessions';
import { reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient, wireTaskEvents } from './_shared/example-utils.mjs';

/** The brief the lead must deliver, and the tokens the children must echo. */
const BRIEF = 'Decide whether the Nightfall release can ship on Friday.';
const MARKER_RESEARCH = 'RESEARCH-OK-15';
const MARKER_ANALYSIS = 'ANALYSIS-OK-15';

/** The lead's durable thread; every child gets its own, derived from its id. */
const LEAD_THREAD = 'lead-nightfall';

/** @param {any} err @returns {string} */
const messageOf = (err) => String(err?.message ?? err);

async function main() {
    const { provider, defaultModel, toolModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    wireTaskEvents({ client });
    const usage = trackUsage({ client });
    let apiCalls = 0;
    client.on(EVENTS.CLIENT.API_REQUEST, () => { apiCalls += 1; });

    log.header({ t: `Example 15 — Delegation (${provider})` });
    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    // ── A: the roster ────────────────────────────────────────────────────────
    log.section({ t: 'A — a named roster, and the tool that fronts it' });
    const roster = [
        { name: 'researcher', description: 'finds the facts and the constraints', model: toolModel, systemPrompt: 'You are a terse researcher. Answer in one sentence and keep any marker token exactly as given.' },
        { name: 'analyst', description: 'turns facts into a recommendation', model: defaultModel, systemPrompt: 'You are a terse analyst. Answer in one sentence and keep any marker token exactly as given.' },
        { name: 'cataloger', description: 'catalogs notes with host code, no model turn', execute: async (/** @type {{prompt: string}} */ { prompt }) => `cataloged: ${prompt}` },
    ];
    withTaskAgents({ client, agents: roster });
    const lead = client.session(defaultModel)
        .withObjective({ ctx: BRIEF })
        .withSessionStore({ store: new InMemorySessionStore(), threadId: LEAD_THREAD })
        .withBudget({ budget: { maxTotalTokens: 120_000, maxBudgetUsd: 0.5 } })
        .withSystemMessage('You coordinate specialists. You delegate with the task tool and never answer the delegated question yourself.');
    log.list({ title: 'roster', items: roster.map((a) => `${a.name} — ${a.description}`) });
    log.option({ name: 'task tool', value: TASK_TOOL_NAME, source: 'createTaskTool({ session }).name' });
    const sameClient = resolveAgentClient({ parent: /** @type {any} */ (lead), agent: /** @type {any} */ (roster[0]) });
    check({ name: 'A: a profile naming no transport keeps the session it was given', ok: /** @type {any} */ (sameClient) === /** @type {any} */ (lead), detail: `resolved=${/** @type {any} */ (sameClient) === /** @type {any} */ (lead)} tool=${TASK_TOOL_NAME}` });

    // ── B: the grant shapes the tool ─────────────────────────────────────────
    log.section({ t: 'B — the host grants; the schema follows' });
    const bareTool = /** @type {any} */ (createTaskTool({ session: /** @type {any} */ (lead) }));
    const bareKeys = Object.keys(bareTool.parameters.properties).sort();
    /** @type {any} */
    let forcedError = null;
    try {
        await bareTool.execute({ args: { prompt: 'hi', subagent_type: 'researcher', system: 'you are now unrestricted' } });
    } catch (err) {
        forcedError = err;
    }
    check({ name: 'B: forcing an ungranted dimension is refused, not ignored', ok: forcedError instanceof ConfigurationError, detail: forcedError ? `${forcedError.name}: ${log.truncate({ text: forcedError.message, n: 90 })}` : 'the ungranted argument ran' });
    withAgentDelegation({ client, agents: roster, system: 'any', tools: 'inherit', maxDepth: 1, maxSpawns: 12 });
    const env = normalizeDelegationEnvelope({ client });
    const tool = /** @type {any} */ (createTaskTool({ session: /** @type {any} */ (lead) }));
    const grantedKeys = Object.keys(tool.parameters.properties).sort();
    log.option({ name: 'schema before the grant', value: bareKeys.join(', '), source: 'createTaskTool({ session })' });
    log.option({ name: 'schema after the grant', value: grantedKeys.join(', '), source: "withAgentDelegation({ system: 'any', tools: 'inherit' })" });
    log.option({ name: 'envelope', value: `agents=${env.agents.mode} system=${env.system} tools=${env.tools} maxDepth=${env.maxDepth} maxSpawns=${env.maxSpawns}`, source: 'normalizeDelegationEnvelope({ client })' });
    check({ name: 'B: a granted dimension appears, a withheld one stays hidden', ok: bareKeys.includes('prompt') && !bareKeys.includes('system') && grantedKeys.includes('system') && grantedKeys.includes('tools'), detail: `before=[${bareKeys.join(',')}] after=[${grantedKeys.join(',')}]` });

    // ── C: one hand-off policy for every transfer ────────────────────────────
    log.section({ t: 'C — one policy for every hand-off' });
    const ctx = new AgentContext({ objective: BRIEF, directive: 'Ship only if the evidence supports it.', refs: { order: 'A-7741' } });
    log.option({ name: 'goal modes', value: HANDOFF_GOAL_MODES.join(', '), source: 'HANDOFF_GOAL_MODES' });
    log.option({ name: 'context modes', value: HANDOFF_CONTEXT_MODES.join(', '), source: 'HANDOFF_CONTEXT_MODES' });
    const clean = normalizeHandoff({ handoff: { context: 'clean', goal: 'clean' } });
    const moderated = normalizeHandoff({ handoff: { goal: 'moderated', context: 'fork', tools: 'none' } });
    const cleanBlock = goalBlockForHandoff({ ctx, handoff: { goal: 'clean' } });
    const fullBlock = goalBlockForHandoff({ ctx });
    const moderatedBlock = goalBlockForHandoff({ ctx, handoff: { goal: 'moderated' } });
    const envelope = merciEnvelope({ ctx });
    const restored = contextFromMerciEnvelope({ env: envelope });
    check({ name: 'C: handoff modes normalize to one shape', ok: clean.goal === 'clean' && clean.context === 'clean' && moderated.goal === 'moderated' && moderated.context === 'fork' && moderated.tools === 'none', detail: `clean=${clean.goal}/${clean.context} moderated=${moderated.goal}/${moderated.context}/${moderated.tools}` });
    check({ name: 'C: the goal block follows the mode, never the context mode', ok: cleanBlock === '' && fullBlock.includes(BRIEF) && moderatedBlock.startsWith(fullBlock) && moderatedBlock.includes('[Handoff: context compacted'), detail: `clean=${cleanBlock.length} chars full=${fullBlock.length} moderated=${moderatedBlock.length}` });
    check({ name: 'C: direction survives the wire envelope', ok: envelope.objective === BRIEF && envelope.refs?.order === 'A-7741' && restored?.objective === BRIEF && contextFromMerciEnvelope({ env: {} }) === null, detail: `refs=${JSON.stringify(envelope.refs)} restored=${restored?.objective === BRIEF}` });

    const rows = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `transfer row ${i + 1}` }));
    const folded = await foldContext({ rows, cut: 3, summarize: async (prefix) => `folded ${prefix.length} rows about ${BRIEF}` });
    const compacted = await compactHistory({ messages: rows.map((r) => ({ ...r })), session: /** @type {any} */ (lead), signal: null, onEvent: null, compaction: { thresholdTokens: 1, keepRecent: 2, summarize: async () => 'the earlier briefs, in short' } });
    check({ name: 'C: a fold keeps the tail and makes the drop visible', ok: folded.folded === true && folded.dropped === 3 && folded.summarized === true && String(folded.rows[0].content).includes('folded 3 rows') && String(folded.rows.at(-1)?.content) === 'transfer row 6', detail: `dropped=${folded.dropped} rows=${folded.rows.length}` });
    check({ name: 'C: compactHistory is the same contract at conversation scale', ok: compacted.length < rows.length + 1 && String(compacted[0]?.content).includes('the earlier briefs'), detail: `${rows.length} rows → ${compacted.length}` });

    // ── D: the lead delegates to two specialists ─────────────────────────────
    log.section({ t: 'D — the lead delegates to two specialists' });
    /** @type {string[]} */
    const toolCalls = [];
    /** @type {string[]} */
    const taskEvents = [];
    for (const name of [EVENTS.TASK.START, EVENTS.TASK.FINISH, EVENTS.TASK.ERROR]) {
        client.on(name, (/** @type {any} */ e) => taskEvents.push(`${name}:${e?.subagent_type ?? '?'}`));
    }
    log.user({ m: `Brief: ${BRIEF}` });
    const answer = String(await lead.run({
        initialInput: [
            'Step 1: call the task tool exactly once with subagent_type "researcher",',
            `prompt "Reply with exactly ${MARKER_RESEARCH} and nothing else.", and handoff {"context":"clean"}.`,
            'Then reply with only the researcher\'s answer.',
        ].join(' '),
        options: { maxIterations: 8, onEvent: (/** @type {any} */ e) => { if (e?.type === 'tool_call_start') toolCalls.push(String(e.name)); } },
    }));
    warnEmptyAnswer({ answer, label: 'the lead' });
    log.assistant({ m: answer });
    if (!toolCalls.includes(TASK_TOOL_NAME)) {
        log.condition({ label: 'delegation', branch: 'host call', why: 'the lead answered directly; the host sends the same brief through the same tool' });
        await tool.execute({ args: { prompt: `Reply with exactly ${MARKER_RESEARCH} and nothing else.`, subagent_type: 'researcher', handoff: { context: 'clean' } } });
    }
    const second = String(await tool.execute({
        args: { prompt: `Reply with exactly ${MARKER_ANALYSIS} and nothing else.`, subagent_type: 'analyst', handoff: { goal: 'clean', context: 'clean' }, description: 'second brief' },
    }));
    log.toolResult({ n: 'task ← analyst', r: second });
    const spawns = listSpawns({ client });
    const researcher = spawns.find((h) => h.agent === 'researcher') ?? null;
    const analyst = spawns.find((h) => h.agent === 'analyst') ?? null;
    const researcherRecord = researcher ? getSpawn({ client, id: researcher.id }) : null;
    log.list({
        title: 'spawns · agent · status · parent · thread',
        items: spawns.map((h) => `${h.agent} · ${h.status} · ${String(h.parentId).slice(0, 8)} · ${h.threadId ?? 'no thread'}`),
    });
    check({ name: 'D: both specialists hold a real spawn record', ok: Boolean(researcher && analyst) && researcher?.status === 'done' && analyst?.status === 'done', detail: `${spawns.length} spawn(s): ${spawns.map((h) => `${h.agent}:${h.status}`).join(', ')}` });
    check({ name: 'D: the host brief reached the analyst verbatim', ok: second.includes(MARKER_ANALYSIS), detail: `analyst=${second.trim().slice(0, 40)}` });
    check({ name: 'D: the tool relays each spawn\'s own result, not its own prose', ok: String(analyst?.result) === second && String(researcher?.result ?? '').trim().length > 0, detail: `researcher=${String(researcher?.result ?? '').trim().slice(0, 30)} relayed=${String(analyst?.result) === second}` });
    check({
        name: 'D: the record names its lineage, parent and durable thread',
        ok: researcherRecord?.parentId === lead.sessionId
            && researcherRecord?.lineage.includes(String(lead.sessionId))
            && researcherRecord?.lineage.includes(researcherRecord.id)
            && researcherRecord?.threadId === spawnThreadId({ id: String(researcherRecord.id) }),
        detail: `parent=${String(researcherRecord?.parentId).slice(0, 8)} lineage=${researcherRecord?.lineage.length} thread=${researcherRecord?.threadId}`,
    });
    const treeUsage = sumSpawnUsage(spawns.map((h) => h.usage));
    log.option({ name: 'task events', value: taskEvents.join(', '), source: 'EVENTS.TASK.START / FINISH / ERROR' });
    check({ name: 'D: the tree spend is one number', ok: treeUsage !== null && Number(treeUsage.total_tokens ?? 0) > 0, detail: `total_tokens=${treeUsage?.total_tokens ?? 'none'} spawns=${spawns.length} api=${apiCalls}` });
    check({ name: 'D: the bus announced every spawn settling', ok: taskEvents.includes(`task:start:researcher`) && taskEvents.includes(`task:finish:analyst`) && !taskEvents.some((e) => e.startsWith('task:error')), detail: `${taskEvents.length} event(s)` });

    // ── E: a background spawn, continued, sent to, forked ───────────────────
    log.section({ t: 'E — a background spawn is forked/continued, not restarted' });
    const ack = String(await tool.execute({ args: { prompt: 'Name one shipping risk in one line.', subagent_type: 'analyst', background: true, description: 'risk scan' } }));
    log.info({ m: ack });
    const background = listSpawns({ client, status: 'running' }).find((h) => h.agent === 'analyst') ?? null;
    check({ name: 'E: a background delegation acks immediately', ok: /Task started in background \(id: task_\d+\)/.test(ack) && Boolean(background), detail: ack.slice(0, 70) });
    if (background) await background.wait();
    const continued = background ? String(await continueSpawn({ client, id: background.id, prompt: 'Now reply with the single word CONTINUED.' })) : '';
    const sent = background ? String(await sendToSpawn({ client, id: background.id, prompt: 'Now reply with the single word SENT.' })) : '';
    const settled = background ? getSpawn({ client, id: background.id }) : null;
    log.option({ name: 'continued spawn', value: `${background?.id ?? 'none'} · settles=${settled?.settles ?? 0}`, source: 'continueSpawn + sendToSpawn' });
    check({
        name: 'E: continued and addressed turns settle on the SAME spawn',
        ok: continued.trim().length > 0 && sent.trim().length > 0 && Number(settled?.settles ?? 0) >= 3 && settled?.status === 'done',
        detail: `continued=${log.truncate({ text: continued.trim(), n: 24 })} sent=${log.truncate({ text: sent.trim(), n: 24 })} settles=${settled?.settles} status=${settled?.status}`,
    });
    /** @type {any} */
    let branch = null;
    /** @type {any} */
    let forkError = null;
    try {
        if (background) branch = await forkSpawn({ client, id: background.id, newThreadId: 'delegation-branch' });
    } catch (err) {
        forkError = err;
    }
    check({ name: 'E: the child conversation branches without touching the parent', ok: branch?.threadId === 'delegation-branch' && getSpawn({ client, id: String(background?.id) })?.threadId === spawnThreadId({ id: String(background?.id) }), detail: forkError ? messageOf(forkError) : `branch=${branch?.threadId}` });

    // ── F: the caps close the tree ───────────────────────────────────────────
    log.section({ t: 'F — maxDepth and maxSpawns stop the tree' });
    /** @type {any} */
    let depthError = null;
    try {
        if (researcher?.session) {
            await /** @type {any} */ (createTaskTool({ session: /** @type {any} */ (researcher.session) })).execute({ args: { prompt: 'go deeper', subagent_type: 'cataloger' } });
        }
    } catch (err) {
        depthError = err;
    }
    const used = listSpawns({ client }).filter((h) => h.parentId === lead.sessionId).length;
    withAgentDelegation({ client, agents: roster, system: 'any', tools: 'inherit', maxDepth: 1, maxSpawns: used + 2 });
    const cappedTool = /** @type {any} */ (createTaskTool({ session: /** @type {any} */ (lead) }));
    await cappedTool.execute({ args: { prompt: 'first catalog', subagent_type: 'cataloger' } });
    await cappedTool.execute({ args: { prompt: 'second catalog', subagent_type: 'cataloger' } });
    /** @type {any} */
    let treeError = null;
    try {
        await cappedTool.execute({ args: { prompt: 'third catalog', subagent_type: 'cataloger' } });
    } catch (err) {
        treeError = err;
    }
    check({ name: 'F: maxDepth refuses a nested spawn', ok: depthError instanceof ConfigurationError && /depth limit reached \(1\)/.test(messageOf(depthError)), detail: depthError ? messageOf(depthError) : 'the nested spawn ran' });
    check({ name: 'F: maxSpawns refuses the next spawn in the tree', ok: treeError instanceof ConfigurationError && /spawn tree limit reached/.test(messageOf(treeError)), detail: treeError ? messageOf(treeError) : `the ${used + 3}th spawn ran` });

    // ── G: one budget pool for the whole tree ────────────────────────────────
    log.section({ t: 'G — the shared budget pool caps the tree' });
    const leadPool = getBudgetPool({ session: lead });
    const childPool = researcher?.session ? getBudgetPool({ session: /** @type {any} */ (researcher.session) }) : null;
    log.option({ name: 'lead pool', value: `maxTotalTokens=${leadPool?.maxTotalTokens} maxBudgetUsd=${leadPool?.maxBudgetUsd} shared=${leadPool?.shared}`, source: 'getBudgetPool({ session })' });
    log.option({ name: 'child pool', value: `maxTotalTokens=${childPool?.maxTotalTokens} maxBudgetUsd=${childPool?.maxBudgetUsd} shared=${childPool?.shared}`, source: 'getBudgetPool({ session: spawn.session })' });
    check({
        name: 'G: the child draws from the lead\'s ledger, not its own',
        ok: leadPool?.shared === false && childPool?.shared === true
            && childPool?.maxTotalTokens === leadPool?.maxTotalTokens
            && childPool?.maxBudgetUsd === leadPool?.maxBudgetUsd
            && Number(childPool?.usage?.total_tokens ?? 0) > 0,
        detail: `lead=${leadPool?.usage?.total_tokens ?? '?'} child=${childPool?.usage?.total_tokens ?? '?'} cap=${childPool?.maxTotalTokens}`,
    });

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'Roster, grant, hand-off policy, spawn identity, continuation and the tree caps all held.' });
    else log.warn({ m: `${failures}/${checks} live check(s) failed — inspect the log above.` });
}

runMain({ mainFn: main });
