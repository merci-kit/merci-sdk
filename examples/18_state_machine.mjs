// @ts-check
/**
 * Example 18 — State machine: a node verify gate + a contract completion gate.
 *
 * A hand-built 3-node graph (`outline → draft → finalize`) executed with the
 * shared StateContext:
 *
 *   A — node verify : the `draft` node owns the gate — an LLM judge checks the
 *       artifact against explicit criteria; a rejection re-runs the node with
 *       the judge's evidence fed back, bounded by `contract.maxRetries`.
 *   B — completion gate : `run({ contract })` adds deterministic criteria over
 *       the final context; a failed criterion marks the run `failed` instead of
 *       reporting done, and the example proves the criterion rejects an empty
 *       artifact without spending an API call.
 *   C — durability : `save()` / `StateMachine.load()` round-trips phase,
 *       current node, visited counts, history, context and verify attempts, so
 *       a restart resumes the machine where it stopped.
 *
 * Public API: `StateMachine`, `wireStateMachineEvents`, `judgeArtifact`.
 *
 * Run: `node examples/18_state_machine.mjs`
 * Needs: `PROVIDER` + provider credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { StateMachine, initializeClient, loadCredentials, log } from 'merci-sdk';
import { judgeArtifact, reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient, wireStateMachineEvents } from './_shared/example-utils.mjs';

const OBJECTIVE = 'Write a database-migration preflight checklist with exactly three bullet items, plus a one-line risk note.';

const DRAFT_CRITERIA = [
    { name: 'the artifact is a preflight checklist with exactly three bullet items' },
    { name: 'the artifact states the migration risk in one line' },
];

/** Hand-built graph; the draft's verify gate is attached in main() (it needs the client). */
/** @param {{model: string}} arg0 */
function buildGraph({ model }) {
    return {
        entry: 'outline',
        nodes: [
            { id: 'outline', model, systemPrompt: 'You are a migration planner. Output a plain 3-line outline of the preflight checklist.', userPromptTemplate: OBJECTIVE },
            { id: 'draft', model, systemPrompt: 'You are a precise technical writer. Produce the final artifact: exactly three bullet lines (each starting with "- ") and one closing risk line. No preamble.', userPromptTemplate: 'Outline:\n{{context.outline}}' },
            { id: 'finalize', model, terminal: true, systemPrompt: 'Normalize the draft: keep the three bullet items and the risk line exactly as written and add nothing.', userPromptTemplate: 'Draft:\n{{context.draft}}' },
        ],
        edges: [
            { from: 'outline', to: 'draft' },
            { from: 'draft', to: 'finalize' },
        ],
    };
}

let failures = 0;
/** @param {{name: string, passed: boolean, detail?: string}} arg0 */
function check({ name, passed, detail }) {
    if (!passed) failures += 1;
    log.check({ name, passed, detail });
}

async function main() {
    const { provider, defaultModel, toolModel } = resolveExample();
    const model = defaultModel || toolModel;
    log.header({ t: `Example 18 — State Machine (${provider})` });

    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    const contract = {
        maxRetries: 2,
        criteria: [
            {
                name: 'a draft artifact exists',
                /** @param {{getAll: () => Record<string, any>}} ctx */
                check: (ctx) => {
                    const draft = String(ctx.getAll()?.draft ?? '').trim();
                    return { passed: draft.length > 0, evidence: draft ? `${draft.length} char(s)` : 'context.draft is empty' };
                },
            },
            {
                name: 'the artifact carries three bullet lines',
                /** @param {{getAll: () => Record<string, any>}} ctx */
                check: (ctx) => {
                    const bullets = String(ctx.getAll()?.draft ?? '').split('\n').filter((l) => l.trim().startsWith('- ')).length;
                    return { passed: bullets >= 3, evidence: `${bullets} bullet line(s)` };
                },
            },
        ],
    };

    const graph = buildGraph({ model });
    const draftNode = /** @type {Record<string, any>} */ (graph.nodes.find((n) => n.id === 'draft'));
    let gateCalls = 0;
    let gatePassed = false;
    draftNode.verify = async (/** @type {any} */ output) => {
        gateCalls += 1;
        const verdict = await judgeArtifact({ client, model, criteria: DRAFT_CRITERIA, state: { objective: OBJECTIVE, artifact: String(output ?? '') } });
        gatePassed = verdict.passed;
        return verdict;
    };

    const sm = new StateMachine({ graph, options: { client, defaultModel: model } });
    wireStateMachineEvents({ sm });

    // ── A/B: run with the node gate + the contract completion gate ──────────
    log.section({ t: 'A/B · run with verify gate + completion criteria' });
    log.user({ m: OBJECTIVE });
    const finalContext = await sm.run({ contract: contract });
    const draft = String(finalContext.getAll().draft ?? '');
    warnEmptyAnswer({ answer: draft, label: 'the state machine' });
    check({ name: 'the machine reached its terminal node', passed: sm.phase === 'done', detail: `phase=${sm.phase} history=${sm.history.length}` });
    check({ name: 'the draft verify gate ran and passed', passed: gateCalls >= 1 && gatePassed, detail: `calls=${gateCalls} lastPassed=${gatePassed}` });

    const recheck = await contract.criteria[1].check(sm.context);
    check({ name: 'the completion criteria accept the final context', passed: recheck.passed, detail: recheck.evidence });

    // ── C: durability — save/load round-trip ────────────────────────────────
    log.section({ t: 'C · save() → StateMachine.load()' });
    const json = sm.save();
    const resumed = StateMachine.load({ json, graph: sm.graph, options: { client, defaultModel: model } });
    check({
        name: 'load() restores phase, current node and context',
        passed: resumed.phase === sm.phase && resumed.current === sm.current && String(resumed.context.getAll().draft ?? '') === draft,
        detail: `phase=${resumed.phase} current=${resumed.current} history=${resumed.history.length}`,
    });

    const rejected = await contract.criteria[0].check({ getAll: () => ({}) });
    check({ name: 'the completion gate rejects an empty artifact', passed: rejected.passed === false, detail: rejected.evidence });

    reportUsage({ provider, usage });
    if (failures > 0) throw new Error(`${failures} check(s) failed`);
    log.success({ m: 'Verify gate, completion criteria and durability verified.' });
}

runMain({ mainFn: main });
