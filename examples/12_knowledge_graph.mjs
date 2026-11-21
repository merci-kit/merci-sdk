// @ts-check
/**
 * Example 12 — The knowledge graph: a contract that can say no.
 *
 * A vendor contract has to be read, not just indexed. The mechanical pass needs
 * no model: sections, definitions, obligations, a prohibition and the condition
 * behind the suspension right all land as typed nodes with source pointers. The
 * model adds only the *issue* the reader must answer and the edges that answer
 * it, through `knowledge_patch`, which is validated before it can touch the
 * graph. The graph then records a rejected reading and a conditional right, and
 * one asserted edge must survive a decision gate before it is admitted.
 *
 * What this shows:
 *   A — mechanical : buildGraph() on a supply agreement; validateGraph(); saveGraph().
 *   B — semantic   : the model adds an `issue` and the `depends_on` edges that answer it.
 *   C — shapes     : a negative edge (the rejected reading), a conditional edge
 *       (only under the payment clause), an evidenced edge (one edge, two sources).
 *   D — gate       : createDecisionGate() admits or rejects one asserted edge.
 *   E — closed     : gatePolicy: 'closed' refuses to read an uncalibrated `null`
 *       verdict as approval.
 *   F — read       : a fresh session answers from the budgeted block alone.
 *
 * Public API: `buildGraph`, `validateGraph`, `applyPatch`, `edgeText`,
 * `renderKnowledgeBlock`, `retrieveSubgraph`, `graphSha`, `loadGraph`,
 * `saveGraph`, `createDecisionGate`, `getDecisionModel`, `providerDescriptorFor`,
 * `.withKnowledge`, `.withDecisionGate`.
 *
 * Run: `node examples/12_knowledge_graph.mjs`
 * Needs: `PROVIDER` plus its credentials in `secret.env`.
 *
 * @version 0.23.0
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
    applyPatch,
    buildGraph,
    createDecisionGate,
    defaultDisplay,
    edgeText,
    getDecisionModel,
    graphSha,
    initializeClient,
    loadCredentials,
    loadGraph,
    log,
    providerDescriptorFor,
    renderKnowledgeBlock,
    retrieveSubgraph,
    saveGraph,
    validateGraph,
} from 'merci-sdk';
import { reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';
import { SCRATCH_DIR } from './_shared/real-tools.mjs';

const STATE_DIR = join(SCRATCH_DIR, '12-knowledge-graph');
const GATE_DIR = join(STATE_DIR, 'gate');
const CLOSED_DIR = join(STATE_DIR, 'closed');

/** Sections, definitions, an obligation, a prohibition, a permission behind a condition. */
const CONTRACT = `# Supply agreement

This Agreement is between Northwind Ltd (the "Customer") and Helios GmbH (the "Supplier").

## 1. Definitions

"Deliverable" means the software listed in Schedule A.
"Defect" means a failure of a Deliverable to conform to Schedule A.

## 2. Delivery

The Supplier shall deliver each Deliverable by the date in Schedule A.
The Supplier shall not subcontract any Deliverable without the Customer's written consent.
Section 3 limits the Customer's remedies for a late Deliverable.
If the Customer is late with a payment, the Supplier may suspend work until the payment is made.

## 3. Liability

Each party's liability is limited to EUR 50,000.
`;

const QUESTION = 'May the Supplier suspend work, and under what condition? Separately: does the agreement require the Supplier to offer alternative work instead of suspending?';

const ENRICH_SYSTEM = [
    'You enrich a knowledge graph. You are given a map of nodes with their ids.',
    'Call `knowledge_patch` exactly once, then stop. Do not query first. Use this shape:',
    '  nodes: [{ id: "I1", kind: "issue", label: "<the question the reader must answer>", derivedFrom: ["<an existing node id>"] }]',
    '  edges: [{ from: "I1", to: "<an existing node id>", rel: "depends_on", note: "<why that clause answers the issue>" }]',
    'Every edge needs `from`, `to`, `rel` and a note. Use only ids the map shows you.',
].join('\n');

/**
 * The same instruction with the real permission id spelled out, so a small
 * model has nothing to invent.
 * @param {{graph: any}} arg0 -
 * @returns {string}
 */
function gateSystemFor({ graph }) {
    const permission = graph.nodes.find((/** @type {any} */ node) => node.kind === 'permission');
    const anchor = graph.nodes.find((/** @type {any} */ node) => node.kind === 'document');
    return [
        'You enrich a knowledge graph. Call `knowledge_patch` exactly once, then stop.',
        'Send exactly this patch and nothing else:',
        JSON.stringify({
            nodes: [{ id: 'I1', kind: 'issue', label: 'does the delivery duty survive a late payment?', derivedFrom: [anchor?.id ?? 'S1-doc'] }],
            edges: [{ from: 'I1', to: permission?.id ?? 'S1-doc', rel: 'depends_on', note: 'the delivery duty is read against the suspension right' }],
        }),
    ].join('\n');
}

const READ_SYSTEM = 'The knowledge graph is injected into your context above. Do NOT call any tools. Answer strictly from it in two short lines, and name the node ids you relied on in square brackets. Read a negative edge as the position that was rejected. If the graph does not answer the question, reply exactly "NOT IN GRAPH".';

/**
 * One model turn whose only write path is the knowledge patch tool.
 * @param {{client: any, model: string, dir: string, graph: any, gate?: any, decisionGate?: any, gatePolicy?: 'closed'|'open', system: string, input: string, label: string, also?: ((event: any) => void)|null}} arg0 -
 * @returns {Promise<{answer: string, graph: any|null}>}
 */
async function patchTurn({ client, model, dir, graph, gate = null, decisionGate = null, gatePolicy = 'closed', system, input, label, also = null }) {
    const builder = client.session(model).withKnowledge({ dir, graph, gate, gatePolicy });
    if (decisionGate) builder.withDecisionGate({ gate: decisionGate });
    const session = builder
        .withSystemMessage(system)
        .withExecute({ options: { rules: { task: 'deny' } } });
    log.user({ m: input });
    const answer = String(await session.run({ initialInput: input, options: { ...defaultDisplay({ also: also ?? undefined }), maxIterations: 8, maxConsecutiveEmpty: 4 } }));
    warnEmptyAnswer({ answer, label });
    const saved = await loadGraph({ dir });
    return { answer, graph: saved.status === 'ok' ? saved.graph : null };
}

async function main() {
    const { provider, defaultModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    log.header({ t: `Example 12 — The knowledge graph (${provider})` });
    await rm(STATE_DIR, { recursive: true, force: true });
    await mkdir(GATE_DIR, { recursive: true });
    await mkdir(CLOSED_DIR, { recursive: true });
    log.option({ name: 'graph.dir', value: STATE_DIR, source: 'withKnowledge({ dir }) + saveGraph({ dir })' });
    log.option({ name: 'graph.gatePolicy', value: 'closed', source: "withKnowledge({ gatePolicy: 'closed' })" });

    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    // ── A: mechanical pass, no model call ────────────────────────────────────
    log.section({ t: 'A — mechanical pass: build the graph with no model call' });
    const graph = buildGraph({ sources: [{ id: 'S1', name: 'supply.md', text: CONTRACT }], title: 'Supply agreement' });
    const kinds = new Set(graph.nodes.map((node) => node.kind));
    const relations = new Set(graph.edges.map((edge) => edge.rel));
    log.event({ type: 'graph built', payload: { nodes: graph.nodes.length, edges: graph.edges.length, kinds: [...kinds].join(',') } });
    check({ name: 'A: sections, paragraphs and definitions', ok: graph.nodes.filter((node) => node.kind === 'section').length >= 3 && kinds.has('definition'), detail: `kinds=${[...kinds].join(',')}` });
    check({ name: 'A: an obligation, a prohibition and a permission', ok: kinds.has('obligation') && kinds.has('prohibition') && kinds.has('permission') });
    check({ name: 'A: the condition behind the suspension right', ok: kinds.has('condition') && relations.has('conditions') && relations.has('references') });
    check({ name: 'A: every node carries a source pointer or is derived', ok: graph.nodes.every((node) => Boolean(node.source) || node.derived === true) });
    const first = validateGraph({ graph });
    check({ name: 'A: the mechanical graph validates', ok: first.status !== 'fail', detail: `status=${first.status} errors=${first.summary.errors}` });

    const writtenPath = await saveGraph({ dir: STATE_DIR, graph });
    const onDisk = await loadGraph({ dir: STATE_DIR });
    check({
        name: 'A: the stored graph keeps its hash',
        ok: onDisk.status === 'ok' && Boolean(onDisk.graph) && onDisk.graph?.sha === graphSha({ graph: onDisk.graph }),
        detail: `${writtenPath.split('/').slice(-3).join('/')} sha=${graphSha({ graph }).slice(0, 12)}`,
    });

    // ── B: the model enriches, through a validated patch ────────────────────
    log.section({ t: 'B — semantic pass: the model adds an issue and the edges that answer it' });
    let patchCalls = 0;
    const countPatch = (/** @type {any} */ event) => {
        if (event?.name !== 'knowledge_patch') return;
        if (event.type === 'tool_call_start') patchCalls++;
        else if (event.type === 'tool_call_end') log.toolResult({ n: 'knowledge_patch', r: event.result });
    };
    const enrichedTurn = await patchTurn({
        client, model: defaultModel, dir: STATE_DIR, graph,
        system: ENRICH_SYSTEM,
        input: 'Enrich the graph with the question a reader must answer about suspending work for a late payment.',
        label: 'the enrichment run',
        also: countPatch,
    });
    const enriched = enrichedTurn.graph;
    check({ name: 'B: the model called knowledge_patch', ok: patchCalls >= 1, detail: `calls=${patchCalls}` });
    check({ name: 'B: the patch reached graph.json on disk', ok: Boolean(enriched) });
    const issue = enriched?.nodes?.find((/** @type {any} */ node) => node.kind === 'issue');
    check({ name: 'B: an issue node was added', ok: Boolean(issue), detail: issue ? `${issue.id}: ${issue.label}` : 'none' });
    const issueEdges = (enriched?.edges ?? []).filter((/** @type {any} */ edge) => issue && edge.from === issue.id);
    check({ name: 'B: the issue is linked to the clauses that answer it', ok: issueEdges.length >= 1, detail: `${issueEdges.length} edge(s)` });
    check({ name: 'B: every semantic edge explains itself', ok: issueEdges.length > 0 && issueEdges.every((/** @type {any} */ edge) => typeof edge.note === 'string' && edge.note.trim().length > 0), detail: issueEdges.map((/** @type {any} */ edge) => edge.rel).join(',') });

    // ── C: the shapes a link cannot carry ───────────────────────────────────
    log.section({ t: 'C — shapes: not this, only then, and on two sources' });
    /** @type {any} */
    const shaped = enriched;
    const permission = shaped?.nodes?.find((/** @type {any} */ node) => node.kind === 'permission');
    const condition = shaped?.nodes?.find((/** @type {any} */ node) => node.kind === 'condition');
    const obligation = shaped?.nodes?.find((/** @type {any} */ node) => node.kind === 'obligation');
    const issueId = issue?.id ?? 'I1';
    if (!shaped || !issue || !permission || !condition) {
        check({ name: 'C: the enriched graph has an issue, a permission and its condition', ok: false, detail: 'missing after enrichment' });
    } else {
        shaped.sources = [...(shaped.sources ?? []), { id: 'S2', name: 'side-letter.md', chars: 0 }];
        applyPatch({ graph: shaped, patch: {
            nodes: [{ id: 'B1', kind: 'boundary', label: 'no duty to offer alternative work instead of suspending', derivedFrom: [issueId] }],
            edges: [{ from: issueId, to: 'B1', rel: 'demarcates', note: 'the rejected reading creates no duty to offer alternative work', polarity: 'negative' }],
        } });
        applyPatch({ graph: shaped, patch: {
            edges: [{ from: issueId, to: permission.id, rel: 'depends_on', note: 'the suspension right exists only under the payment condition', condition: condition.id }],
        } });
        applyPatch({ graph: shaped, patch: {
            edges: [{ from: issueId, to: obligation?.id ?? permission.id, rel: 'supports', note: 'both instruments record the delivery duty', evidence: [{ sourceId: 'S1' }, { sourceId: 'S2' }] }],
        } });
        const negative = shaped.edges.find((/** @type {any} */ edge) => edge.polarity === 'negative');
        const conditional = shaped.edges.find((/** @type {any} */ edge) => Boolean(edge.condition));
        const evidenced = shaped.edges.find((/** @type {any} */ edge) => Array.isArray(edge.evidence) && edge.evidence.length > 1);
        check({ name: 'C: the negative edge records the rejected reading', ok: negative?.polarity === 'negative' && negative?.to === 'B1' });
        check({ name: 'C: the negative edge renders with its marker', ok: edgeText({ edge: negative ?? null, target: negative?.to ?? '', arrow: '→' }).startsWith('¬'), detail: edgeText({ edge: negative ?? null, target: negative?.to ?? '', arrow: '→' }) });
        check({ name: 'C: the conditional edge names a real clause', ok: Boolean(conditional) && Boolean(shaped.nodes.find((/** @type {any} */ node) => node.id === conditional?.condition)), detail: `condition=${conditional?.condition}` });
        check({ name: 'C: the conditional edge renders "only when"', ok: edgeText({ edge: conditional ?? null, target: conditional?.to ?? '', arrow: '→' }).includes('only when') });
        check({ name: 'C: one edge carries both sources', ok: Boolean(evidenced) && edgeText({ edge: evidenced ?? null, target: evidenced?.to ?? '', arrow: '→' }).includes('(2 sources)'), detail: edgeText({ edge: evidenced ?? null, target: evidenced?.to ?? '', arrow: '→' }) });

        let refused = false;
        try {
            applyPatch({ graph: shaped, patch: { edges: [{ from: issueId, to: permission.id, rel: 'depends_on', note: 'x', condition: 'no-such-node' }] } });
        } catch (error) {
            refused = /conditioned on unknown node/.test(String(/** @type {Error} */ (error).message));
        }
        check({ name: 'C: a condition on a missing node is refused, not stored', ok: refused });

        const report = validateGraph({ graph: shaped, sources: { S1: CONTRACT } });
        check({ name: 'C: the shaped graph validates', ok: report.status !== 'fail', detail: `status=${report.status} errors=${report.summary.errors} warnings=${report.summary.warnings}` });

        const retrieved = await retrieveSubgraph({ graph: shaped, text: 'may the supplier suspend work, and is alternative work required' });
        const block = renderKnowledgeBlock({ graph: shaped, result: retrieved });
        check({ name: 'C: the block carries the shapes, not JSON', ok: Boolean(block) && block !== null && block.includes('¬demarcates') && block.includes('only when') && !block.includes('"edges"'), detail: `${String(block).length} chars, ${retrieved.nodes.length} node(s)` });

        await saveGraph({ dir: STATE_DIR, graph: shaped });
        check({ name: 'C: the shapes are persisted under the same dir', ok: (await loadGraph({ dir: STATE_DIR })).status === 'ok' });
    }

    // ── D: a real classifier admits or rejects one asserted edge ─────────────
    log.section({ t: 'D — gate: the agent asserts, a classifier decides' });
    const decisionWire = providerDescriptorFor({ provider })?.models.decision ?? null;
    const decisionModel = getDecisionModel({ provider });
    const decisions = /** @type {any} */ (client).decisions;
    log.option({ name: 'decision.wire', value: decisionWire ?? '(none)', source: 'providerDescriptorFor({ provider }).models.decision' });
    log.option({ name: 'decision.model', value: decisionModel ?? '(none)', source: 'getDecisionModel({ provider })' });

    let gated = 0;
    let rejected = 0;
    client.on('knowledge:edge_rejected', (/** @type {any} */ event) => {
        rejected++;
        log.event({ type: 'knowledge:edge_rejected', payload: event });
    });
    const gate = createDecisionGate({
        ask: async (/** @type {{state: unknown, questions: Record<string, any>}} */ { state, questions }) => {
            gated++;
            return decisions.ask({ model: decisionModel, state, questions });
        },
        seam: 'example-12',
    });
    if (!decisionWire || typeof decisions?.ask !== 'function') {
        log.event({ type: 'live gate skipped', payload: { provider, reason: 'no decision wire on this provider' } });
        check({ name: 'D: the decision wire is available', ok: false, detail: `SKIP: ${provider} has no decision wire` });
    } else {
        const gateGraph = buildGraph({ sources: [{ id: 'S1', name: 'supply.md', text: CONTRACT }], title: 'Supply agreement' });
        /** @param {any} edge */
        const isStructural = (edge) => ['contains', 'part_of', 'defines', 'references', 'derived_from', 'mentions'].includes(edge.rel);
        const before = gateGraph.edges.filter(isStructural).length;
        const gatedTurn = await patchTurn({
            client, model: defaultModel, dir: GATE_DIR, graph: gateGraph, gate, decisionGate: gate, gatePolicy: 'closed',
            system: gateSystemFor({ graph: gateGraph }),
            input: 'Record the open question in the graph.',
            label: 'the gated enrichment',
        });
        const gatedGraph = gatedTurn.graph;
        check({ name: 'D: the gate was consulted', ok: gated >= 1, detail: `calls=${gated}` });
        check({ name: 'D: the issue node still lands', ok: Boolean(gatedGraph?.nodes?.some((/** @type {any} */ node) => node.id === 'I1')), detail: gatedGraph ? `${gatedGraph.nodes.length} node(s)` : 'no graph' });
        const semantic = (gatedGraph?.edges ?? []).filter((/** @type {any} */ edge) => edge.rel === 'depends_on');
        // The invariant, not the model's opinion: a rejected edge is absent, an
        // unopposed one is present. Either way the gate — not the agent — decided.
        check({
            name: 'D: the edge exists exactly when the gate did not reject it',
            ok: gated >= 1 && ((rejected > 0 && semantic.length === 0) || (rejected === 0 && semantic.length >= 1)),
            detail: `gated=${gated} rejected=${rejected} admitted=${semantic.length}`,
        });
        const structural = (gatedGraph?.edges ?? []).filter(isStructural);
        check({ name: 'D: structural edges were never gated', ok: structural.length >= before && gated < structural.length, detail: `structural=${structural.length} gated=${gated}` });
    }

    // ── E: closed policy — "could not decide" is not "yes" ──────────────────
    log.section({ t: 'E — closed: an uncalibrated verdict does not admit an edge' });
    const undecided = { gate: async () => ({ verdict: null, escalated: true, reason: 'calibration unavailable' }) };
    const closedGraph = buildGraph({ sources: [{ id: 'S1', name: 'supply.md', text: CONTRACT }], title: 'Supply agreement' });
    const closedTurn = await patchTurn({
        client, model: defaultModel, dir: CLOSED_DIR, graph: closedGraph, gate: undecided, decisionGate: undecided, gatePolicy: 'closed',
        system: gateSystemFor({ graph: closedGraph }),
        input: 'Record the open question in the graph.',
        label: 'the closed-policy enrichment',
    });
    check({ name: 'E: the node lands even when the gate cannot decide', ok: Boolean(closedTurn.graph?.nodes?.some((/** @type {any} */ node) => node.id === 'I1')) });
    check({ name: 'E: the asserted edge does not', ok: !(closedTurn.graph?.edges ?? []).some((/** @type {any} */ edge) => edge.rel === 'depends_on'), detail: `depends_on=${(closedTurn.graph?.edges ?? []).filter((/** @type {any} */ edge) => edge.rel === 'depends_on').length}` });

    // ── F: a fresh session answers from the budgeted block alone ────────────
    log.section({ t: 'F — read: a fresh session answers from the injected block only' });
    const readSession = client.session(defaultModel)
        .withKnowledge({ dir: STATE_DIR, preload: true })
        .withSystemMessage(READ_SYSTEM)
        .withExecute({ options: { rules: { task: 'deny' } } });
    log.user({ m: QUESTION });
    const answer = String(await readSession.run({ initialInput: QUESTION, options: { ...defaultDisplay(), maxIterations: 8, maxConsecutiveEmpty: 4 } }));
    warnEmptyAnswer({ answer, label: 'the graph read' });
    check({ name: 'F: the answer names a graph node', ok: /\[[A-Za-z0-9._:-]+\]/.test(answer), detail: log.truncate({ text: answer, n: 150 }) });
    check({ name: 'F: the answer states the condition', ok: /late|payment|overdue/i.test(answer), detail: log.truncate({ text: answer, n: 150 }) });
    check({ name: 'F: the answer denies the alternative-work duty', ok: /\b(no|not|does not|doesn't|no such)\b/i.test(answer) && /alternative/i.test(answer), detail: log.truncate({ text: answer, n: 150 }) });

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'The graph recorded, the model added only the reading, and the gate kept the right to say no.' });
    else log.warn({ m: `${failures}/${checks} live check(s) failed — inspect the log above.` });
}

runMain({ mainFn: main });
