// @ts-check
/**
 * Example 19 — A decision group: task DAG → debate → judge → conclude.
 *
 * One DiscussionSession, three named roles, one real decision (ship the v2
 * billing API on Friday or not). The ledger is the single source of truth, so
 * every phase builds on the previous one:
 *
 *   A — runTasks : a dependsOn DAG seeds the ledger in dependency order.
 *   B — discuss  : one sequential debate turn (allowPass + a termination
 *                  predicate that stops the run at the ledger cap).
 *   C — judge    : an asVerdict judge scores the strongest contribution.
 *   D — conclude : discuss → judge → bounded replan → aggregate, `accepted`.
 *   E — ledger   : the cap is deliberately tiny (5) so eviction fires; every
 *                  drop is announced via `discussion:ledger_pruned`, the next
 *                  turn sees an explicit "[Earlier discussion entries omitted]"
 *                  marker, and appended − retained must equal the announced
 *                  drops — eviction is never silent.
 *
 * Public API: `DiscussionSession`, `initializeClient`, `loadCredentials`,
 * `log`.
 *
 * Run: `node examples/19_discussion.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { DiscussionSession, initializeClient, loadCredentials, log } from 'merci-sdk';
import { reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient, wireDiscussionEvents } from './_shared/example-utils.mjs';

const OBJECTIVE = 'Decide whether the v2 billing API ships this Friday and name the conditions that must hold before it does.';

/** Deliberately tiny — section E exists to watch the memory-safety valve fire. */
const LEDGER_CAP = 5;

const TASKS = [
    { title: 'collect constraints', assignee: 'sre', description: 'List the top three operational constraints for a Friday ship. At most 50 words.' },
    { title: 'assess impact', assignee: 'product', dependsOn: ['collect constraints'], description: 'Given the constraints already on the ledger, state the customer impact of a one-week delay. At most 50 words.' },
    { title: 'draft go/no-go', assignee: 'lead', dependsOn: ['assess impact'], description: 'Draft the go/no-go recommendation with exactly one condition. At most 50 words.' },
];

/**
 * Prints the check and fails the run (non-zero exit) when it does not hold.
 * @param {{name: string, ok: boolean, detail?: string}} arg0
 */
function check({ name, ok, detail = '' }) {
    log.check({ name, passed: ok, detail });
    if (!ok) throw new Error(`check failed: ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
    const { provider, defaultModel, toolModel } = resolveExample();

    log.header({ t: `Example 19 — Multi-agent decision group (${provider})` });
    log.option({ name: 'provider', value: provider, source: 'resolveProvider()' });
    log.option({ name: 'objective', value: OBJECTIVE, source: 'DiscussionSession options.objective' });
    log.option({ name: 'ledger cap', value: LEDGER_CAP, source: "options.maxLedgerEntries + ledgerPruneMode: 'marker'" });

    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    const group = new DiscussionSession({
        client,
        options: { objective: OBJECTIVE, maxLedgerEntries: LEDGER_CAP, ledgerPruneMode: 'marker' },
    });
    wireDiscussionEvents({ group });

    /** @type {Array<{ dropped: number, prunedTotal: number, cap: number, summarized: boolean }>} */
    const prunes = [];
    /** @type {string[]} */
    const dagOrder = [];
    let appended = 0;
    group.on('discussion:dag_order', (e) => { dagOrder.push(...e.order); });
    group.on('discussion:ledger_entry', () => { appended++; });
    group.on('discussion:ledger_pruned', (e) => {
        prunes.push(e);
        log.warn({ m: `ledger eviction announced: dropped ${e.dropped} (total ${e.prunedTotal}/${e.cap}, summarized=${e.summarized}) — the next turn sees the omission marker` });
    });

    group
        .addAgent({ name: 'product', persona: 'You are the product lead. Argue from customer value; at most 50 words.', model: defaultModel, provider })
        .addAgent({ name: 'sre', persona: 'You are the SRE. Attack operational risk with concrete constraints; at most 50 words.', model: toolModel, provider })
        .addAgent({ name: 'lead', persona: 'You are the engineering lead and mediator. Weigh both sides and drive to a decision; at most 50 words.', model: defaultModel, provider });
    log.list({ title: 'agents', items: group.getAgents().map((a) => a.name) });

    // ── A: the task DAG seeds the ledger ─────────────────────────────────────
    log.section({ t: 'A — runTasks: dependency-ordered seeding' });
    await group.runTasks({ tasks: TASKS, sequential: true });
    const seeded = /** @type {Array<any>} */ (group.getLedger());
    check({
        name: 'runTasks followed dependsOn order and every task produced text',
        ok: dagOrder.join(' → ') === TASKS.map((t) => t.title).join(' → ')
            && seeded.length === TASKS.length
            && seeded.every((e) => e.type === 'task' && !String(e.content).startsWith('[error:')),
        detail: `order=${dagOrder.join(' → ')} entries=${seeded.length} authors=${seeded.map((e) => e.author).join(',')}`,
    });
    log.list({ title: 'seeded ledger', items: seeded.map((e) => `${e.author} (${e.type}): ${log.truncate({ text: String(e.content).replace(/\s+/g, ' '), n: 70 })}`) });

    // ── B: one debate turn, bounded by the termination predicate ─────────────
    log.section({ t: 'B — discuss: one sequential turn, allowPass, termination' });
    const debate = await group.discuss({
        instruction: 'Debate the go/no-go draft: challenge its weakest assumption and defend your strongest condition.',
        turns: 2,
        sequential: true,
        allowPass: true,
        /** @param {{ledger: Array<any>}} arg0 */
        termination: ({ ledger }) => ledger.length >= LEDGER_CAP,
    });
    check({
        name: 'discuss stopped on the termination predicate after one turn',
        ok: debate.stopped === true && debate.reason === 'termination condition met' && debate.turns === 1,
        detail: JSON.stringify(debate),
    });

    // ── C: the judge returns a machine-readable verdict ──────────────────────
    log.section({ t: 'C — judge: asVerdict' });
    const verdict = /** @type {any} */ (await group.judge({
        instruction: 'Judge the debate: is the go/no-go defensible and specific?',
        options: { asVerdict: true },
    }));
    check({
        name: 'judge returned a structured verdict',
        ok: typeof verdict?.passed === 'boolean' && Number.isFinite(verdict?.score) && (verdict?.revision === 'minor' || verdict?.revision === 'full'),
        detail: `passed=${verdict?.passed} score=${verdict?.score} revision=${verdict?.revision} reason=${log.truncate({ text: String(verdict?.reason ?? ''), n: 90 })}`,
    });

    // ── D: the closed loop — conclude ────────────────────────────────────────
    log.section({ t: 'D — conclude: discuss → judge → replan* → aggregate' });
    const conclusion = /** @type {any} */ (await group.conclude({
        instruction: 'Produce the final go/no-go decision and the conditions that must hold before Friday.',
        options: {
            maxRounds: 1,
            discuss: { turns: 1, instruction: 'Re-examine the strongest remaining objection.' },
            judge: { minScore: 70, instruction: 'Judge whether the decision is defensible, specific, and its conditions are explicit.' },
            aggregate: { persona: 'You are the decision owner. State the final go/no-go and its conditions in at most 80 words.' },
        },
    }));
    warnEmptyAnswer({ answer: conclusion?.content, label: 'the discussion' });
    check({
        name: 'conclude aggregated a final decision',
        ok: typeof conclusion?.content === 'string' && conclusion.content.trim().length > 0 && !conclusion.content.startsWith('[error:'),
        detail: `accepted=${conclusion?.accepted} score=${conclusion?.verdict?.score ?? 'n/a'} content=${log.truncate({ text: String(conclusion?.content ?? '').replace(/\s+/g, ' '), n: 120 })}`,
    });

    // ── E: every eviction is announced ───────────────────────────────────────
    log.section({ t: 'E — ledger valve: announced evictions, no silent drops' });
    const finalLedger = /** @type {Array<any>} */ (group.getLedger());
    const retained = finalLedger.length;
    const dropped = prunes.reduce((n, e) => n + e.dropped, 0);
    check({
        name: 'ledger evictions are announced and add up',
        ok: prunes.length > 0
            && dropped === appended - retained
            && retained <= LEDGER_CAP
            && prunes.every((e) => e.dropped > 0 && e.summarized === false && e.cap === LEDGER_CAP),
        detail: `appended=${appended} retained=${retained} announced=${dropped} events=${prunes.length} cap=${LEDGER_CAP}`,
    });
    log.list({ title: 'retained ledger', items: finalLedger.map((e) => `${e.author} (${e.type}): ${log.truncate({ text: String(e.content).replace(/\s+/g, ' '), n: 70 })}`) });

    reportUsage({ provider, usage });
    log.success({ m: 'Discussion decision group complete.' });
}

runMain({ mainFn: main });
