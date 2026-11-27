// @ts-check
/**
 * Example 13 — A corpus that becomes a wiki, and survives an edit.
 *
 * A documentation folder is the cheapest knowledge base a team already has.
 * This example turns five markdown pages, one memory fact and one todo into a
 * single graph, renders the wiki a human reads, and then edits the world under
 * it — twice — to show what is derived, what is adopted, and what survives:
 *
 *   A — SURFACES : `wikiSurface()` imports the folder as `section` nodes plus
 *       `references` edges (a dangling `[[link]]` is data, not an error), and
 *       the read-only `memory` / `todos` adapters merge in through
 *       `surfaceFragment()` + `mergeFragment()`. Nothing is written back.
 *   B — RENDER   : `renderWiki()` writes one page per node; the index carries
 *       `graph-sha256`, which is how staleness is proved.
 *   C — ROUTE    : a model, given only the rendered map, routes a 429 question
 *       to one page and answers from it.
 *   D — STALE    : any edit after a render is a `wiki-stale` finding; only a
 *       re-render clears it.
 *   E — ONTOLOGY : `profileSources()` measures the corpus, `proposeOntology()`
 *       proposes kinds and relations with the evidence for each, adoption is
 *       versioned and compare-and-swapped, and the graph is rebuilt inside it.
 *   F — CACHE    : `syncCorpus()` writes `manifest.json` with an explicit
 *       builder version; an unchanged corpus costs nothing, and an edited file
 *       rebuilds only the mechanical layer while the model's nodes are
 *       re-anchored by content key.
 *   G — ORPHAN   : remove the paragraph a node was derived from and the node is
 *       dropped — provenance that no longer resolves is not kept.
 *
 * What this shows:
 *   - one store, two projections: the wiki is a view, not a second database;
 *   - read-only surfaces: memory and todos are indexed without being written;
 *   - an ontology with evidence, adopted as a versioned, swappable act;
 *   - a delta rebuild that treats the agent's work as data.
 *
 * Run: `node examples/13_knowledge_corpus.mjs`
 * Needs: `PROVIDER` plus its credentials in `secret.env`.
 *
 * @version 0.25.0
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    adoptOntology, adoptedProfile, applyPatch, buildGraph, corpusKey, defaultDisplay,
    fingerprintSources, graphSha, initializeClient, loadCorpus, loadCredentials, log,
    memorySurface, mergeFragment, ontologySha, profileSources, proposeOntology, readSources,
    readWikiSha, renderKnowledgeBlock, renderWiki, saveGraph, sourceDelta, surfaceFragment, syncCorpus,
    todosSurface, validateGraph, wikiSurface,
} from 'merci-sdk';
import { extractAndParseJson } from 'merci-sdk/json';
import { reportUsage, resolveExample, runMain, trackUsage, warnEmptyAnswer, wireClient } from './_shared/example-utils.mjs';
import { SCRATCH_DIR } from './_shared/real-tools.mjs';

const STATE_DIR = join(SCRATCH_DIR, '13-knowledge-corpus');
const CORPUS_DIR = join(STATE_DIR, 'corpus');
const STORE_DIR = join(STATE_DIR, 'store');
const CACHE_DIR = join(STATE_DIR, 'cache');
const CORPUS_BUILD_VERSION = 7;

/** @type {Record<string, string>} */
const PAGES = {
    'getting_started.md': `# Getting started with Relay

Read when: you are wiring a new service into Relay for the first time.
Not for: production incidents; start at [[incidents]].

## Provisioning

You must request a project id before the first call.
The platform shall issue credentials within one working day.
If the project is new, the request must include a data classification.
Read [[retries]] before you send production traffic.
`,
    'retries.md': `# Retries and idempotency

Read when: a request failed and you are deciding whether to send it again.
Not for: quota planning; see [[rate_limits]].

## Safe retries

A retry is safe only if the request carries an idempotency key.
You must not retry a write that has no idempotency key.
The client shall back off for at least 200 ms before the second attempt.
If the first attempt timed out, the retry must reuse the same key.
Unless the gateway returns 503, do not retry more than three times.

## Retry budget

A retry budget is spent on repeat attempts, never on first attempts.
The budget shall reset at the start of each quota window.
`,
    'rate_limits.md': `# Rate limits and backoff

Read when: a client sees HTTP 429 or quota errors.
Not for: retry safety; see [[retries]].

## Quota windows

The gateway shall count requests per one-minute quota window.
A client must send an exponential backoff after a 429 response.
If the response carries Retry-After, the client must wait that long.
Unless the Retry-After header is absent, do not invent a longer delay.

## Escalation

A sustained 429 rate above five percent is an incident; see [[incidents]].
`,
    'incidents.md': `# Incident response

Read when: you are paged for Relay or a client reports an outage.
Not for: routine quota questions; see [[rate_limits]].

## Declaring an incident

The on-call engineer must declare an incident within five minutes of a page.
The incident commander shall open a bridge and name a scribe.
If the error budget is exhausted, the release train must stop.
Unless the page is a false alarm, the scribe must record a timeline.
Run the steps in [[runbook_db]] before you escalate to the platform team.
`,
    'glossary.md': `# Glossary

Read when: a term used on another page is unclear.
Not for: onboarding steps; start with [[getting_started]].

"Retry budget" means the share of traffic a client may spend on repeat attempts.
"Burn rate" means the speed at which a service consumes its error budget.
"Idempotency key" means a client-generated value that makes a repeat safe.
"Quota window" means the fixed interval over which rate limits are counted.
`,
};

const FACTS = [{ id: 'fact_1', content: 'The Relay on-call rota is published in #relay-oncall every Monday.', category: 'process' }];
const TASKS = [{ id: 't1', description: 'draft the runbook for quota exhaustion', status: 'pending', dependsOn: [] }];
const QUESTION = 'A client keeps receiving HTTP 429 responses and asks how long to wait before retrying. Which page should I read, and what does it say?';
const ENRICH_SYSTEM = [
    'You enrich a knowledge graph. The graph map is injected into your context.',
    'Reply with ONE JSON object and nothing else — no prose, no tool call:',
    '{"label": "<one open question about retry safety>", "derivedFrom": ["<paragraph id from retries.md>"]}',
    'Node ids look like S2-p-9; take one from the injected map. The patch is applied and validated by the SDK.',
].join('\n');

async function main() {
    const { provider, defaultModel } = resolveExample();
    const { client } = await initializeClient({ provider, options: loadCredentials({ provider }) });
    wireClient({ client });
    const usage = trackUsage({ client });

    log.header({ t: `Example 13 — A corpus that becomes a wiki (${provider})` });
    await rm(STATE_DIR, { recursive: true, force: true });
    await mkdir(CORPUS_DIR, { recursive: true });
    for (const [name, body] of Object.entries(PAGES)) await writeFile(join(CORPUS_DIR, name), body, 'utf8');
    const paths = Object.keys(PAGES).map((name) => join(CORPUS_DIR, name));
    log.option({ name: 'corpus', value: CORPUS_DIR, source: 'wikiSurface({ dir })' });
    log.option({ name: 'store', value: STORE_DIR, source: 'saveGraph({ dir }) + renderWiki({ dir })' });
    log.option({ name: 'cache', value: CACHE_DIR, source: 'syncCorpus({ dir }) — graph.json + manifest.json' });
    log.option({ name: 'surfaces', value: 'wiki, memory, todos', source: 'surfaceFragment() + mergeFragment()' });

    let checks = 0;
    let failures = 0;
    /** @param {{name: string, ok: boolean, detail?: string}} arg0 */
    const check = ({ name, ok, detail = '' }) => {
        checks++;
        if (!ok) failures++;
        log.check({ name, passed: ok, detail });
    };

    // ── A: the folder, the bank and the task list become one graph ──────────
    log.section({ t: 'A — surfaces: one graph over the folder, the memory bank and the tasks' });
    const graph = wikiSurface({ dir: CORPUS_DIR, title: 'Relay operations handbook' });
    const rels = new Set(graph.edges.map((edge) => edge.rel));
    const dangling = graph.edges.filter((edge) => edge.unresolved);
    log.event({ type: 'corpus imported', payload: { nodes: graph.nodes.length, edges: graph.edges.length, relations: [...rels].join(','), dangling: dangling.length } });
    check({ name: 'A: one node per page', ok: graph.nodes.length === Object.keys(PAGES).length, detail: `${graph.nodes.length} page(s)` });
    check({ name: 'A: the importer emits structure and references only', ok: [...rels].every((rel) => rel === 'references'), detail: [...rels].join(',') });
    check({ name: 'A: a dangling [[link]] is data, not a validation failure', ok: dangling.length === 1 && validateGraph({ graph }).status !== 'fail', detail: `${dangling.length} unresolved, status=${validateGraph({ graph }).status}` });
    const rateLimits = graph.nodes.find((node) => node.id === 'rate_limits');
    check({ name: 'A: routing metadata survives the import', ok: Boolean(rateLimits?.when) && (rateLimits?.notFor?.length ?? 0) > 0, detail: rateLimits ? `${rateLimits.when} / not for: ${rateLimits.notFor?.join(',')}` : 'none' });

    const todoStore = new Map(TASKS.map((task) => [task.id, task]));
    mergeFragment({ graph, fragment: surfaceFragment({ surface: 'memory', input: { facts: FACTS } }) });
    mergeFragment({ graph, fragment: surfaceFragment({ surface: 'todos', input: { store: todoStore } }) });
    const surfaces = new Set(graph.nodes.map((node) => node.surface));
    check({ name: 'A: all three surfaces are in one store', ok: ['wiki', 'memory', 'todos'].every((name) => surfaces.has(name)), detail: [...surfaces].join(',') });
    check({ name: 'A: the memory adapter invents no similarity edge', ok: memorySurface({ facts: FACTS }).edges.length === 0 });
    const todoFragment = todosSurface({ store: todoStore });
    check({ name: 'A: the todo adapter keeps the task’s own state', ok: todoFragment.nodes.length === 1 && todoFragment.nodes[0]?.surface === 'todos' && (todoFragment.nodes[0]?.tags ?? []).includes('pending'), detail: `T-${TASKS[0]?.id}` });
    await saveGraph({ dir: STORE_DIR, graph });
    check({ name: 'A: the saved store has one hash', ok: graphSha({ graph }) === graph.sha, detail: graph.sha?.slice(0, 12) });

    // ── B: the graph becomes the wiki a human reads ─────────────────────────
    log.section({ t: 'B — render: pages, a hash in the index, a dangling link kept visible' });
    const rendered = renderWiki({ graph, dir: STORE_DIR });
    check({ name: 'B: a page was written for every node', ok: rendered.pages >= graph.nodes.length, detail: `${rendered.pages} page(s)` });
    check({ name: 'B: the index carries the graph hash', ok: readWikiSha({ dir: STORE_DIR }) === graphSha({ graph }) });
    check({ name: 'B: a fresh render is not stale', ok: !validateGraph({ graph, wikiSha: readWikiSha({ dir: STORE_DIR }) }).findings.some((finding) => finding.code === 'wiki-stale') });
    const incidentsPage = await readFile(join(STORE_DIR, 'wiki', 'nodes', 'incidents.md'), 'utf8');
    check({ name: 'B: the dangling link is rendered as an edge, not a broken page', ok: incidentsPage.includes('link to runbook_db'), detail: 'edges are data; the index stays valid' });

    // ── C: route one question to one page ───────────────────────────────────
    log.section({ t: 'C — route: the model answers from the rendered map and names the page' });
    const ROUTE_SYSTEM = 'The knowledge graph map is injected into your context. Do NOT call any tools. Answer in two short lines and name the page ids you used in square brackets, for example [rate_limits].';
    const routeSession = client.session(defaultModel)
        .withKnowledge({ dir: STORE_DIR, preload: true })
        .withSystemMessage(ROUTE_SYSTEM)
        .withExecute({ options: { rules: { task: 'deny' } } });
    log.option({ name: 'knowledge.preload', value: 'true', source: 'withKnowledge({ preload })' });
    log.user({ m: QUESTION });
    const answer = String(await routeSession.run({ initialInput: QUESTION, options: { ...defaultDisplay(), maxConsecutiveEmpty: 4 } }));
    warnEmptyAnswer({ answer, label: 'the wiki route' });
    check({ name: 'C: the answer routes to the rate-limit page', ok: /rate_limits/.test(answer), detail: log.truncate({ text: answer, n: 150 }) });
    check({ name: 'C: the answer carries that page’s guidance', ok: /429|Retry-After|backoff/i.test(answer), detail: log.truncate({ text: answer, n: 150 }) });

    // ── D: an edit after a render is a finding, not a silent divergence ─────
    log.section({ t: 'D — stale: edit the graph, prove the wiki is behind, re-render' });
    applyPatch({ graph, patch: { nodes: [{ id: 'issue_quota', kind: 'issue', label: 'who owns paging when the quota window is exhausted?', derivedFrom: ['rate_limits', 'incidents'] }] } });
    await saveGraph({ dir: STORE_DIR, graph });
    const stale = validateGraph({ graph, wikiSha: readWikiSha({ dir: STORE_DIR }) });
    check({ name: 'D: the edit makes the wiki stale', ok: stale.findings.some((finding) => finding.code === 'wiki-stale') });
    renderWiki({ graph, dir: STORE_DIR });
    check({ name: 'D: re-rendering clears it', ok: !validateGraph({ graph, wikiSha: readWikiSha({ dir: STORE_DIR }) }).findings.some((finding) => finding.code === 'wiki-stale') });

    // ── E: measure, propose, adopt, rebuild ─────────────────────────────────
    log.section({ t: 'E — ontology: the corpus proposes its own vocabulary, adoption is reviewed' });
    const sources = readSources({ paths });
    const profile = profileSources({ sources });
    log.event({ type: 'measured', payload: { headings: profile.headings, paragraphs: profile.paragraphs, definitions: profile.definitions, obligation: profile.modality.obligation ?? 0, condition: profile.modality.condition ?? 0 } });
    check({ name: 'E: the corpus was measured, not assumed', ok: profile.definitions >= 3 && (profile.modality.obligation ?? 0) >= 3 && (profile.modality.condition ?? 0) >= 3, detail: `definitions=${profile.definitions} obligations=${profile.modality.obligation ?? 0} conditions=${profile.modality.condition ?? 0}` });

    const proposal = proposeOntology({ profile });
    log.option({ name: 'ontology.proposal', value: `${proposal.kinds.length} kind(s), ${proposal.relations.length} relation(s)`, source: 'proposeOntology({ profile })' });
    for (const entry of proposal.kinds) log.event({ type: 'kind proposed', payload: { kind: entry.kind, support: entry.support, why: entry.why } });
    for (const entry of proposal.relations) log.event({ type: 'relation proposed', payload: { rel: entry.rel, support: entry.support, why: entry.why } });
    check({ name: 'E: the proposed kinds match what the corpus supports', ok: ['section', 'definition', 'obligation', 'condition'].every((kind) => proposal.profile.kinds.includes(kind)), detail: proposal.profile.kinds.slice(0, 8).join(',') });
    check({ name: 'E: every kind carries the count that justified it', ok: proposal.kinds.every((entry) => entry.support >= 1 && entry.why.length > 0) });
    check({ name: 'E: every relation carries its own evidence', ok: proposal.relations.length > 0 && proposal.relations.every((entry) => entry.support >= 1 && entry.why.length > 0) });
    check({ name: 'E: the proposal is not an adoption', ok: proposal.status === 'proposed' });

    const again = proposeOntology({ profile: profileSources({ sources }) });
    check({ name: 'E: the derivation is deterministic', ok: ontologySha({ proposal }) === ontologySha({ proposal: again }) && JSON.stringify(proposal.profile) === JSON.stringify(again.profile), detail: `sha=${proposal.sha}` });

    const adopted = await adoptOntology({ dir: STORE_DIR, proposal });
    const vocabulary = await adoptedProfile({ dir: STORE_DIR });
    if (!vocabulary) throw new Error('adoption did not produce a readable profile');
    log.option({ name: 'ontology.file', value: join(STORE_DIR, 'ontology.json'), source: `adoptOntology({ expected }) — v${adopted.version}` });
    check({ name: 'E: adoption wrote a version', ok: adopted.version === 1 && adopted.sha === proposal.sha, detail: `v${adopted.version} sha=${adopted.sha}` });
    check({ name: 'E: the adopted vocabulary reads back', ok: vocabulary.kinds.includes('obligation') && vocabulary.proposalSha === proposal.sha, detail: `${vocabulary.kinds.length} kind(s)` });
    let refused = false;
    try {
        await adoptOntology({ dir: STORE_DIR, proposal, expected: 'stale-sha' });
    } catch (error) {
        refused = /changed since you read it/.test(String(/** @type {Error} */ (error).message));
    }
    check({ name: 'E: an adoption from a stale reading is refused', ok: refused });

    const rebuilt = buildGraph({ sources, profile: vocabulary, title: 'Relay operations handbook (adopted)' });
    const report = validateGraph({ graph: rebuilt, profile: vocabulary, sources: Object.fromEntries(sources.map((source) => [source.id, source.text])) });
    log.event({ type: 'rebuilt in the adopted vocabulary', payload: { nodes: rebuilt.nodes.length, edges: rebuilt.edges.length, kinds: [...new Set(rebuilt.nodes.map((node) => node.kind))].join(',') } });
    check({ name: 'E: no node kind falls outside the adopted vocabulary', ok: rebuilt.nodes.every((node) => vocabulary.kinds.includes(node.kind)) });
    check({ name: 'E: the rebuilt graph validates against it', ok: report.status !== 'fail', detail: `status=${report.status} errors=${report.summary.errors}` });
    await saveGraph({ dir: STORE_DIR, graph: rebuilt });
    renderWiki({ graph: rebuilt, dir: STORE_DIR });
    check({ name: 'E: the wiki is re-rendered inside the adopted vocabulary', ok: readWikiSha({ dir: STORE_DIR }) === graphSha({ graph: rebuilt }) && rebuilt.profile === 'derived', detail: `profile=${rebuilt.profile}` });

    // ── F: the corpus cache — build once, then pay only for the delta ───────
    log.section({ t: 'F — cache: fingerprints, a free reload, a delta rebuild that keeps the model’s work' });
    let corpusBuilds = 0;
    /** @param {{sources: Array<any>, profile: any, title?: string}} arg0 */
    const buildCorpus = ({ sources: buildSources, profile, title }) => {
        corpusBuilds++;
        return buildGraph({ sources: buildSources, profile, title });
    };
    log.option({ name: 'cache.buildVersion', value: CORPUS_BUILD_VERSION, source: 'syncCorpus({ build, buildVersion })' });
    const fingerprints = fingerprintSources({ sources });
    const key = corpusKey({ sources: fingerprints, profile: vocabulary, buildVersion: CORPUS_BUILD_VERSION });
    log.event({ type: 'fingerprinted', payload: { sources: fingerprints.length, key: key.slice(0, 12) } });
    const first = await syncCorpus({ dir: CACHE_DIR, paths, profile: vocabulary, build: buildCorpus, buildVersion: CORPUS_BUILD_VERSION });
    const stored = await loadCorpus({ dir: CACHE_DIR });
    if (!stored.manifest) throw new Error('syncCorpus wrote no manifest');
    check({ name: 'F: manifest.json fingerprints every source', ok: stored.manifest.sources.length === paths.length && stored.manifest.sources.every((source) => source.sha256.length === 64), detail: `${stored.manifest.sources.length} source(s)` });
    check({ name: 'F: the manifest key is the content key', ok: stored.manifest.key === key && first.key === key && first.reused === false && first.written === true, detail: `nodes=${first.graph.nodes.length}` });
    check({ name: 'F: the manifest records the custom builder version', ok: stored.manifest.buildVersion === CORPUS_BUILD_VERSION, detail: `buildVersion=${stored.manifest.buildVersion}` });

    // The map is rendered into the system prompt here instead of being preloaded
    // by `withKnowledge`: a preloaded graph also registers its tools, and a model
    // that prefers calling a tool over answering JSON turns a one-shot enrichment
    // into a tool loop. Section C is where the preloaded read path is proven.
    let corpus = await loadCorpus({ dir: CACHE_DIR });
    const cacheGraphForMap = corpus.graph ?? first.graph;
    const mapBlock = renderKnowledgeBlock({ graph: cacheGraphForMap }) ?? '(the graph map is empty)';
    const enrichSession = client.session(defaultModel)
        .withSystemMessage(`${ENRICH_SYSTEM}\n\n${mapBlock}`)
        .withExecute({ options: { rules: { task: 'deny' } } });
    log.user({ m: 'Record the open question the retry guidance leaves: when is a repeat attempt no longer safe?' });
    const enrichAnswer = String(await enrichSession.run({ initialInput: 'Record one open question about retry safety, anchored to a paragraph in retries.md. Answer with the JSON object only.', options: { ...defaultDisplay(), maxConsecutiveEmpty: 4 } }));
    warnEmptyAnswer({ answer: enrichAnswer, label: 'the enrichment run' });
    // The model proposes; `applyPatch` validates before the graph changes. A
    // rejected anchor is a warning, not a broken run — the fallback below is
    // mechanical and proves the same provenance rule.
    // A fenced ```json block is the usual answer shape, so the extractor scans
    // for the matching brace span instead of assuming the whole reply is JSON.
    const proposed = extractAndParseJson({ input: enrichAnswer });
    const proposedData = /** @type {{label?: unknown, derivedFrom?: unknown[]}} */ (proposed.success ? proposed.data ?? {} : {});
    const picked = Array.isArray(proposedData.derivedFrom) && proposedData.derivedFrom.length > 0 ? proposedData : null;
    if (picked && corpus.graph) {
        try {
            applyPatch({
                graph: corpus.graph,
                patch: { nodes: [{ id: 'I1', kind: 'issue', label: String(picked.label ?? 'when does a retry stop being safe?'), derivedFrom: (picked.derivedFrom ?? []).map(String) }] },
                profile: vocabulary,
            });
            await saveGraph({ dir: CACHE_DIR, graph: corpus.graph });
            corpus = await loadCorpus({ dir: CACHE_DIR });
        } catch (err) {
            log.warn({ m: `the model proposed an anchor the graph rejects — anchoring deterministically: ${/** @type {any} */ (err)?.message ?? String(err)}` });
        }
    }
    if (!(corpus.graph?.nodes ?? []).some((node) => node.derived)) {
        log.event({ type: 'fallback', payload: { reason: 'the model recorded no patch; anchoring deterministically' } });
        const cacheGraph = first.graph;
        const anchor = cacheGraph.nodes.find((node) => node.source?.sourceId === 'S2' && node.kind === 'paragraph' && String(node.text).includes('idempotency key')) ?? cacheGraph.nodes.find((node) => node.source?.sourceId === 'S2' && node.kind === 'paragraph');
        applyPatch({ graph: cacheGraph, patch: { nodes: [{ id: 'issue_retry', kind: 'issue', label: 'when does a retry stop being safe?', derivedFrom: [anchor?.id ?? 'S2-doc'] }] }, profile: vocabulary });
        await saveGraph({ dir: CACHE_DIR, graph: cacheGraph });
        corpus = await loadCorpus({ dir: CACHE_DIR });
    }
    const derived = (corpus.graph?.nodes ?? []).filter((node) => node.derived);
    const derivedLabel = String(derived[0]?.label ?? '');
    check({ name: 'F: the model’s node names its evidence', ok: derived.length >= 1 && derived.every((node) => (node.derivedFrom?.length ?? 0) > 0), detail: `${derived.length} derived, anchor=${derived[0]?.derivedFrom?.[0]}` });

    const startedReload = Date.now();
    const second = await syncCorpus({ dir: CACHE_DIR, paths, profile: vocabulary, build: buildCorpus, buildVersion: CORPUS_BUILD_VERSION });
    const reloadMs = Date.now() - startedReload;
    log.event({ type: 'cache hit', payload: { ms: reloadMs, reused: second.reused, written: second.written } });
    check({ name: 'F: an unchanged corpus costs nothing', ok: second.reused === true && second.written === false && second.delta.clean && corpusBuilds === 1, detail: `${reloadMs} ms, added=${second.delta.added.length} changed=${second.delta.changed.length} builds=${corpusBuilds}` });
    check({ name: 'F: the hit kept the same graph and every derived node', ok: graphSha({ graph: second.graph }) === graphSha({ graph: /** @type {any} */ (corpus.graph) }) && second.graph.nodes.filter((node) => node.derived).length === derived.length });

    const anchorSourceId = String(second.graph.nodes.find((node) => node.id === derived[0]?.derivedFrom?.[0])?.source?.sourceId ?? 'S2');
    const names = Object.keys(PAGES);
    const editedName = names.find((name, index) => `S${index + 1}` !== anchorSourceId) ?? names[0] ?? 'getting_started.md';
    await writeFile(join(CORPUS_DIR, editedName), `${PAGES[editedName]}\n## Retention\n\nDelivery records must be kept for six years.\n`, 'utf8');
    const delta = sourceDelta({ stored: stored.manifest.sources, current: fingerprintSources({ sources: readSources({ paths }) }) });
    log.event({ type: 'delta', payload: { edited: editedName, changed: delta.changed.length, unchanged: delta.unchanged.length } });
    check({ name: 'F: the delta names exactly the edited file', ok: delta.changed.length === 1 && delta.unchanged.length === paths.length - 1 && delta.added.length === 0 });
    const third = await syncCorpus({ dir: CACHE_DIR, paths, profile: vocabulary, build: buildCorpus, buildVersion: CORPUS_BUILD_VERSION });
    check({ name: 'F: only the mechanical layer was rebuilt', ok: third.reused === false && third.delta.changed.length === 1 && third.graph.nodes.some((node) => String(node.text ?? '').includes('six years')) });
    const survived = third.graph.nodes.find((node) => node.derived && node.label === derivedLabel);
    check({ name: 'F: a node anchored elsewhere survived by content key', ok: Boolean(survived) && third.derived.kept >= 1, detail: `kept=${third.derived.kept} dropped=${third.derived.dropped} edited=${editedName}` });
    check({ name: 'F: its anchor was rewritten to the fresh graph', ok: Boolean(survived) && third.graph.nodes.some((node) => node.id === survived?.derivedFrom?.[0]), detail: survived?.derivedFrom?.join(',') ?? 'none' });

    // ── G: provenance that no longer resolves is dropped ────────────────────
    log.section({ t: 'G — orphan: remove the evidence, the model’s node goes with it' });
    const anchorId = survived?.derivedFrom?.[0];
    const anchorSource = String(third.graph.nodes.find((node) => node.id === anchorId)?.source?.sourceId ?? '');
    const anchorIndex = Number(anchorSource.replace('S', '')) - 1;
    const anchorName = names[anchorIndex] ?? names[0] ?? 'retries.md';
    await writeFile(join(CORPUS_DIR, anchorName), '# Rewritten\n\nNo earlier guidance survives here.\n', 'utf8');
    const fourth = await syncCorpus({ dir: CACHE_DIR, paths, profile: vocabulary, build: buildCorpus, buildVersion: CORPUS_BUILD_VERSION });
    log.event({ type: 'orphan check', payload: { file: anchorName, kept: fourth.derived.kept, dropped: fourth.derived.dropped } });
    check({ name: 'G: the node whose evidence is gone is dropped', ok: fourth.derived.dropped >= 1 && !fourth.graph.nodes.some((node) => node.derived && node.label === derivedLabel), detail: `dropped=${fourth.derived.dropped}` });
    check({ name: 'G: the rebuilt corpus still validates', ok: validateGraph({ graph: fourth.graph, profile: vocabulary }).status !== 'fail' && fourth.graph.nodes.length > 0, detail: `${fourth.graph.nodes.length} node(s)` });

    reportUsage({ provider, usage });
    log.totals({ entries: { checks, failed: failures } });
    if (failures === 0) log.success({ m: 'The corpus became a wiki, the wiki survived staleness, and the agent’s work survived an edit it did not depend on.' });
    else log.warn({ m: `${failures}/${checks} live check(s) failed — inspect the log above.` });
}

runMain({ mainFn: main });
