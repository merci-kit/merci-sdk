// @ts-check
/**
 * Example 04 — Judgment: typed answers, then a gate in code.
 *
 * A support inbox is triaged by a discriminative ("System One") model, not by
 * prose. The model reads one ticket and answers a map of typed questions —
 * yes/no, pick-one, score — and then plain code decides what happens:
 *
 *   A — the request   : ONE live `decisions.ask` on the selected provider
 *       answers three primitives at once: is this a refund request (`noul`),
 *       which team owns it (`choice`), how urgent is it (`score`).
 *   B — the typed read: `readDecisionAnswer` turns each answer into its type,
 *       and `createDecisionGate` acts only above a certainty. Below the
 *       threshold (or on any non-answer) the gate escalates to the LLM path
 *       instead of guessing; the policy itself is two numbers and a fallback.
 *   C — the runtime   : `createRoleClients` resolves the generative, embedding
 *       and decision surfaces independently, `createAgenticRuntime` hands ONE
 *       gate to every seam, `withDecisionGate` installs it on a session, and a
 *       `createDecisionReranker` built from the decision client orders memory
 *       hits by relevance rather than by cosine.
 *   D — calibration   : `decisionCalibration` turns a labelled sample into the
 *       evidence for (or against) the threshold.
 *
 * Thresholds are application policy: probe them on your own labelled sample,
 * then keep them next to the code that acts on them.
 *
 * Public API: `initializeClient`, `loadCredentials`, `getDecisionModel`,
 * `createDecisionsClient`, `noulQuestion`, `choiceQuestion`, `scoreQuestion`,
 * `readDecisionAnswer`, `createDecisionGate`, `createRoleClients`,
 * `resolveRole`, `createAgenticRuntime`, `createDecisionReranker`,
 * `decisionCalibration`, `EVENTS`, `log`.
 *
 * Run: `node examples/04_judgment.mjs`
 * Needs: `PROVIDER` plus its key and `DEFAULT_<PROVIDER>_DECISION_MODEL` in
 *        `secret.env` (decision wires: openai, openrouter, opencode, google_genai).
 *
 * @version 0.23.0
 */
import {
    EVENTS, choiceQuestion, createAgenticRuntime, createDecisionGate, createDecisionReranker,
    createDecisionsClient, createRoleClients, decisionCalibration, getDecisionModel,
    initializeClient, loadCredentials, log, noulQuestion, readDecisionAnswer, resolveRole, scoreQuestion,
} from 'merci-sdk';
import { reportUsage, resolveExample, runMain, trackUsage, wireClient } from './_shared/example-utils.mjs';

const TICKET = 'My payments have failed for three days and I am losing sales. I want my money back. Please help now.';
const TEAMS = { billing: 'Charges, invoices, payment failures.', account: 'Login, profile, permissions.', other: 'Anything else.' };
const URGENCY = ['Low', 'Normal', 'High', 'Critical'];

/** The threshold is application policy, not a vendor fact. */
const ACT_ABOVE = 0.8;

/** Memory hits for the reranker: the relevant fact is placed SECOND on purpose. */
const MEMORY_QUERY = 'why are my card payments failing?';
const MEMORY_FACTS = [
    { content: 'The support inbox is staffed from 09:00 to 17:00 CET.' },
    { content: 'The customer card was declined three times by the issuer.' },
];

/**
 * The three primitives in one request: a yes/no, a closed-world choice and a
 * score on an ordered rubric.
 * @returns {Record<string, any>} the questions, keyed by answer name
 */
function triageQuestions() {
    return {
        refund: noulQuestion({ instructions: 'Is the customer asking for a refund?' }),
        team: choiceQuestion({ instructions: 'Which team should handle this ticket?', criteria: TEAMS }),
        urgency: scoreQuestion({ instructions: 'How urgent is this ticket?', criteria: URGENCY }),
    };
}

/**
 * The whole policy: two thresholds and a fallback, no model involved.
 * @param {{refund: boolean|null, escalated: boolean, urgency: number, team: string}} arg0
 * @returns {string} the action to take
 */
function route({ refund, escalated, urgency, team }) {
    if (escalated) return 'escalate_to_llm';
    if (refund) return 'refund_queue';
    if (urgency >= URGENCY.length - 1) return 'priority_queue';
    return team;
}

async function main() {
    const { provider } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    const decisionModel = getDecisionModel({ provider });
    log.header({ t: `Example 04 — Judgment (${provider})` });
    log.option({ name: 'provider', value: provider, source: 'resolveExample() — PROVIDER in secret.env' });
    log.option({ name: 'decision.model', value: decisionModel || '(unset)', source: 'getDecisionModel({ provider }) — DEFAULT_<PROVIDER>_DECISION_MODEL' });
    log.option({ name: 'gate.threshold', value: ACT_ABOVE, source: 'createDecisionGate({ threshold }) — act only above this certainty' });
    log.option({ name: 'ticket', value: TICKET, source: 'the one state every question reads' });

    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    // ── A: one request, three typed answers ─────────────────────────────────
    log.section({ t: 'A — one decision request, three primitives' });
    const credentials = /** @type {any} */ (loadCredentials({ provider }));
    let started = 0;
    let finished = 0;
    client.on(EVENTS.CLIENT.DECISIONS_START, () => { started += 1; });
    client.on(EVENTS.CLIENT.DECISIONS_FINISH, () => { finished += 1; });
    const decisions = createDecisionsClient({
        provider, apiKey: credentials.apiKey, baseURL: credentials.baseURL ?? null, emitter: client,
    });
    /** @type {NonNullable<(Parameters<typeof createDecisionGate>[0])>['ask']} */
    const askDecision = /** @type {NonNullable<(Parameters<typeof createDecisionGate>[0])>['ask']} */ (/** @type {unknown} */ (decisions.ask));
    const triage = createDecisionGate({ ask: askDecision, threshold: ACT_ABOVE, seam: 'inbox' });

    log.user({ m: TICKET });
    const result = await triage.ask({ state: { ticket: TICKET, channel: 'email' }, questions: triageQuestions() });
    if (!result) throw new Error('the decision surface answered nothing');
    /** @type {NonNullable<(Parameters<typeof readDecisionAnswer>[0])>['answers']} */
    const answers = /** @type {NonNullable<(Parameters<typeof readDecisionAnswer>[0])>['answers']} */ (result.answers);
    const refund = readDecisionAnswer({ answers, name: 'refund', type: 'noul' });
    const team = readDecisionAnswer({ answers, name: 'team', type: 'choice' });
    const urgency = readDecisionAnswer({ answers, name: 'urgency', type: 'score' });
    log.list({
        title: 'one request, three typed answers',
        items: [
            `noul   refund  : P(yes) = ${Number(refund.probability).toFixed(3)} (confidence ${refund.confidence ?? 'not reported'})`,
            `choice team    : ${String(team.choice)} (top ${Number(team.probabilities?.[String(team.choice)] ?? 0).toFixed(2)})`,
            `score  urgency : ${Number(urgency.score).toFixed(2)} of ${URGENCY.length - 1} → ${urgency.legend?.[String(Math.round(Number(urgency.score)))] ?? '—'}`,
        ],
    });
    check({
        name: 'noul answers with a probability in [0,1]',
        ok: Number(refund.probability) >= 0 && Number(refund.probability) <= 1,
        detail: String(refund.probability),
    });
    check({
        name: 'choice answers with one of the declared teams',
        ok: Object.hasOwn(TEAMS, String(team.choice)),
        detail: `${team.choice} ∈ {${Object.keys(TEAMS).join(', ')}}`,
    });
    check({
        name: 'score answers inside the rubric and keeps its legend',
        ok: Number(urgency.score) >= 0 && Number(urgency.score) <= URGENCY.length - 1
            && urgency.legend?.[String(Math.round(Number(urgency.score)))] === URGENCY[Math.round(Number(urgency.score))],
        detail: `score=${urgency.score} legend=${urgency.legend?.[String(Math.round(Number(urgency.score)))]}`,
    });
    check({
        name: 'the decision lifecycle fired once and the request used input tokens',
        ok: started === 1 && finished === 1 && Number(result.usage?.inputTokens ?? 0) > 0,
        detail: `start=${started} finish=${finished} in=${result.usage?.inputTokens} out=${result.usage?.outputTokens ?? 0}`,
    });

    // ── B: the gate, and the policy in code ────────────────────────────────
    log.section({ t: 'B — the gate acts above certainty; the policy is plain code' });
    const verdict = await triage.gate({
        state: { ticket: TICKET },
        question: noulQuestion({ instructions: 'Is this a refund request that needs a human now?' }),
    });
    log.condition({
        label: 'the gate',
        branch: verdict.escalated ? 'escalate' : String(verdict.verdict),
        why: `certainty ${verdict.certainty === null ? 'unknown' : verdict.certainty.toFixed(3)} vs threshold ${ACT_ABOVE}`,
    });
    check({
        name: 'the gate escalates exactly when the certainty is under the threshold',
        ok: verdict.escalated === (verdict.verdict === null || verdict.certainty === null || verdict.certainty < ACT_ABOVE),
        detail: `verdict=${verdict.verdict} certainty=${verdict.certainty} escalated=${verdict.escalated}`,
    });

    const liveAction = route({
        refund: (refund.probability ?? 0) >= 0.5,
        escalated: verdict.escalated,
        urgency: Number(urgency.score),
        team: String(team.choice),
    });
    log.info({ m: `live policy → ${liveAction} (refund=${refund.probability} urgency=${urgency.score} team=${team.choice})` });

    const cases = [
        { args: { refund: true, escalated: false, urgency: 3, team: 'billing' }, want: 'refund_queue' },
        { args: { refund: false, escalated: false, urgency: 3, team: 'billing' }, want: 'priority_queue' },
        { args: { refund: false, escalated: false, urgency: 0, team: 'account' }, want: 'account' },
        { args: { refund: true, escalated: true, urgency: 3, team: 'billing' }, want: 'escalate_to_llm' },
    ];
    check({
        name: 'the policy table holds for refund, urgency, fallback and escalation',
        ok: cases.every(({ args, want }) => route(/** @type {any} */ (args)) === want),
        detail: cases.map(({ args, want }) => `${route(/** @type {any} */ (args)) === want ? '✓' : '✗'} ${want}`).join(' · '),
    });

    // ── C: roles, one gate for every seam, and the memory reranker ─────────
    log.section({ t: 'C — one runtime, one gate for every seam' });
    const roles = await createRoleClients();
    const decisionRole = resolveRole({ role: 'decision' });
    const runtime = await createAgenticRuntime({ seams: ['inbox', 'memory'] });
    log.list({
        title: 'roles resolved independently',
        items: Object.entries(roles).map(([role, entry]) => `${role.padEnd(11)}: ${entry.provider} / ${entry.model}`),
    });
    check({
        name: 'all three roles resolve a provider and a model',
        ok: ['generative', 'embedding', 'decision'].every((role) => Boolean(roles[role]?.provider) && typeof roles[role]?.model === 'string'),
        detail: Object.keys(roles).join(', '),
    });
    check({
        name: 'resolveRole agrees with the client createRoleClients built',
        ok: decisionRole.provider === roles.decision.provider && decisionRole.model === roles.decision.model,
        detail: `${decisionRole.provider}/${decisionRole.model}`,
    });

    const fragments = [runtime.sessionOptions, runtime.dag.evaluatorOptions, runtime.dag.executorOptions, runtime.sm.options, runtime.discussion.options];
    check({
        name: 'one gate instance reaches every option fragment, one cached gate per seam',
        ok: runtime.gate.available
            && fragments.every((fragment) => fragment.decisionGate === runtime.gate)
            && Object.entries(runtime.gates).every(([seam, gate]) => gate === runtime.gateFor({ seam }) && gate.available),
        detail: `gate=${runtime.gate.available} seams=${Object.keys(runtime.gates).join(',')} fragments=${fragments.length}`,
    });
    /** @type {Function|undefined} */
    const openSession = runtime.roles.generative.session;
    if (!openSession) throw new Error('the generative role exposes no session()');
    const gatedSession = openSession().withDecisionGate({ gate: runtime.gate });
    check({
        name: 'withDecisionGate installs that gate on a session',
        ok: Boolean(gatedSession?._decisionGate),
        detail: `session=${gatedSession?.constructor?.name ?? 'none'} gate=${Boolean(gatedSession?._decisionGate)}`,
    });
    check({
        name: 'the runtime exposes a reranker built from its decision role',
        ok: typeof runtime.memory.reranker === 'function',
        detail: typeof runtime.memory.reranker,
    });

    const rerank = createDecisionReranker({ ask: roles.decision.ask, maxCandidates: 2 });
    const ordered = await rerank({ text: MEMORY_QUERY, facts: MEMORY_FACTS });
    log.list({ title: 'memory hits after the reranker', items: ordered.map((fact, index) => `${index + 1}. ${fact.content}`) });
    check({
        name: 'the reranker puts the relevant fact first (it started second)',
        ok: ordered.length === MEMORY_FACTS.length && ordered[0]?.content === MEMORY_FACTS[1].content,
        detail: ordered.map((fact) => String(fact.content).slice(0, 40)).join(' | '),
    });

    // ── D: calibration — measure the threshold, do not inherit it ──────────
    log.section({ t: 'D — the threshold is measured, not inherited' });
    const calibration = decisionCalibration({
        samples: [
            { probability: 0.95, expected: true },
            { probability: 0.9, expected: true },
            { probability: 0.65, expected: false },
            { probability: 0.3, expected: false },
            { probability: 0.8, expected: true },
        ],
        thresholds: [0.5, 0.8, 0.95],
    });
    log.list({
        title: `calibration over ${calibration.count} labelled samples`,
        items: [
            `ECE   : ${calibration.ece.toFixed(3)}`,
            `Brier : ${calibration.brier.toFixed(3)}`,
            ...calibration.sweep.map(({ threshold, coverage, accuracy }) => `≥ ${threshold.toFixed(2)} → coverage ${(coverage * 100).toFixed(0).padStart(3)}% · accuracy ${accuracy === null ? '—' : (accuracy * 100).toFixed(0)}%`),
        ],
    });
    check({
        name: 'calibration reports ECE, Brier and a threshold sweep',
        ok: calibration.count === 5 && Number.isFinite(calibration.ece) && Number.isFinite(calibration.brier)
            && calibration.sweep.length === 3,
        detail: `ece=${calibration.ece.toFixed(3)} brier=${calibration.brier.toFixed(3)} sweep=${calibration.sweep.length}`,
    });
    check({
        name: 'a higher threshold decides less of the sample',
        ok: calibration.sweep[0].coverage >= calibration.sweep[1].coverage
            && calibration.sweep[1].coverage >= calibration.sweep[2].coverage,
        detail: calibration.sweep.map((point) => point.coverage.toFixed(2)).join(' ≥ '),
    });

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'Three primitives, one gate, and a threshold that can be defended.' });
    else log.warn({ m: `${failures}/${checks} live check(s) failed — inspect the log above.` });
}

runMain({ mainFn: main });
