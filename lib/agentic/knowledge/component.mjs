// @ts-check
/**
 * @file The knowledge capability component: ASG + wiki as one capability.
 * @version 0.25.0
 *
 * @description
 * A `LoadableComponent`, so it plugs into a session through the same
 * `withCapability` seam memory and todos use.
 *
 * Two deliberate choices:
 *   - the step block is **volatile** (the builder marks it so), because it is
 *     keyed on the last user turn and must not enter the cached prompt prefix;
 *   - the block is a *rendered subgraph*, never the graph. A 600-node graph
 *     pasted into a prompt is worse than a section map plus a query tool.
 *
 * `load` answers a query; `save` applies a validated patch. Nothing here calls
 * a model unless a decision gate was supplied, and then only for an
 * agent-authored non-structural edge.
 */

import { join } from 'node:path';
import { writeJsonAtomic } from '../../support/fs-store.mjs';
import { deepFreeze } from '../../support/object.mjs';
import { ConfigurationError } from '../../core/errors.mjs';
import { CAPABILITY, CAPABILITY_REGISTRY, KNOWLEDGE_PATCH_TOOL_NAME, KNOWLEDGE_QUERY_TOOL_NAME } from '../../core/constants/capability.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { LoadableComponent } from '../../core/loadable.mjs';
import { EVENTS } from '../../core/events.mjs';
import { KNOWLEDGE_SCHEMA, STRUCTURAL_RELATIONS, applyPatch, resolveProfile, validateGraph } from './model.mjs';
import { graphTextSize, readWikiSha, renderKnowledgeBlock, renderWiki } from './render.mjs';
import { adoptOntology, adoptedProfile, knowledgePaths, loadGraph, promotableRelations, saveGraph } from './store.mjs';
import { profileSources, proposeOntology } from './profile.mjs';
import { queryGraph, retrieveSubgraph } from './query.mjs';
import { mergeFragment, readTextFile, surfaceFragment } from './adapters.mjs';

/**
 * The slice of a `DecisionGate` the knowledge layer reads: one yes/no call per
 * agent-authored semantic edge.
 * @typedef {Object} KnowledgeGate
 * @property {(arg0: {state: unknown, question: {question: string}}) => Promise<{verdict?: boolean|null, certainty?: number|null, escalated?: boolean|null, reason?: string|null}>} gate
 */

/**
 * The loose row shape this component inspects. Only these fields are read, so a
 * provider-specific row is structurally acceptable.
 * @typedef {Object} KnowledgeRowLike
 * @property {string} [role]
 * @property {string} [type]
 * @property {string|Array<{text?: string}>} [content]
 * @property {Array<{text?: string}>} [parts]
 * @property {unknown} [merciInjection]
 */

/**
 * The last non-injection user text in the row array.
 * @param {{messages: KnowledgeRowLike[]}} arg0 -
 * @returns {string}
 */
function lastUserText({ messages }) {
    for (let index = (messages ?? []).length - 1; index >= 0; index--) {
        const row = messages[index];
        if (!row) continue;
        if (row.role !== 'user' && row.type !== 'user_message') continue;
        if (row.merciInjection) continue;
        if (typeof row.content === 'string') return row.content;
        if (Array.isArray(row.parts)) return (/** @type {Array<{text?: string}>} */ (row.parts)).map((/** @type {{text?: string}} */ part) => part?.text ?? '').join(' ');
    }
    return '';
}

/**
 * The document texts a seed names, for profiling. Only the document surface is
 * read here: the other surfaces are already structured, so their shape is known.
 * @param {{seed: Record<string, unknown>|null, surfaces: Array<string>}} arg0 -
 * @returns {Array<{id: string, name: string, text: string}>}
 */
function readSeededSources({ seed, surfaces }) {
    if (!seed?.document) return [];
    if (!surfaces.includes('document')) return [];
    const input = seed.document;
    const options = /** @type {{paths?: Array<string>}|string|Array<string>} */ (input);
    const paths = typeof options === 'string' ? [options] : (Array.isArray(options) ? options : (options.paths ?? []));
    return paths.map((/** @type {string} */ path, /** @type {number} */ index) => ({
        id: `S${index + 1}`,
        name: path.split('/').pop() ?? path,
        text: readTextFile({ path })
    }));
}

/**
 * The knowledge capability.
 * @extends {LoadableComponent}
 */
export class KnowledgeComponent extends LoadableComponent {
    /**
     * @param {{dir?: string, graph?: import('./model.mjs').KnowledgeGraph|null, profile?: string|object|null, preload?: boolean, embedder?: Function|null, gate?: KnowledgeGate|null, gatePolicy?: 'closed'|'open', ontology?: 'auto'|'adopted'|null, surfaces?: Array<string>, seed?: Record<string, unknown>|null, sources?: Record<string, string>|null, view?: 'asg'|'wiki', access?: 'read-only'|'read-write', persist?: boolean, scorer?: import('./query.mjs').KnowledgeScorer|null, edgeFilter?: import('./query.mjs').KnowledgeEdgeFilter|null, direction?: 'both'|'outgoing'|'incoming', hubDamping?: boolean, eventEmitter?: import('node:events').EventEmitter|null}} arg0 -
     */
    constructor({ dir = '.knowledge', graph = null, profile = null, preload = false, embedder = null, gate = null, gatePolicy = 'closed', ontology = null, surfaces = ['document'], seed = null, sources = null, view = 'asg', access = 'read-write', persist = true, scorer = null, edgeFilter = null, direction = 'both', hubDamping = true, eventEmitter = null } = {}) {
        if (!['read-only', 'read-write'].includes(access)) throw new ConfigurationError({ message: `Unknown knowledge access '${access}'.` });
        if (!['both', 'outgoing', 'incoming'].includes(direction)) throw new ConfigurationError({ message: `Unknown traversal direction '${direction}'.` });
        super({
            id: CAPABILITY.KNOWLEDGE,
            loadToolName: KNOWLEDGE_QUERY_TOOL_NAME,
            saveToolName: KNOWLEDGE_PATCH_TOOL_NAME,
            announce: CAPABILITY_REGISTRY[CAPABILITY.KNOWLEDGE]?.announce ?? null,
            eventEmitter,
            loadDescription: 'Read a bounded subgraph of the knowledge graph. Pass an id for a neighbourhood, or a query for a ranked reading set. Never request the whole graph.',
            saveDescription: 'Apply a knowledge patch: add or update nodes and edges. A custom relation (x-*) needs a note; endpoints must exist.',
            loadParameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Node id to centre on.' },
                    query: { type: 'string', description: 'Free-text query for a ranked reading set.' },
                    depth: { type: 'number', description: 'Traversal depth (bounded by the runtime limit).' },
                    budget: { type: 'number', description: 'Character budget for the rendered answer.' },
                    page: { type: 'boolean', description: 'Return the wiki page for `id` instead of a subgraph.' }
                },
                required: []
            },
            saveParameters: {
                type: 'object',
                properties: {
                    nodes: { type: 'array', items: { type: 'object' }, description: 'Nodes to add.' },
                    edges: { type: 'array', items: { type: 'object' }, description: 'Edges to add: {from, to, rel, note}.' },
                    updateNodes: { type: 'array', items: { type: 'object' }, description: 'Existing nodes to update.' },
                    removeNodes: { type: 'array', items: { type: 'string' } },
                    removeEdges: { type: 'array', items: { type: 'string' } }
                },
                required: []
            }
        });
        this.dir = dir ?? '.knowledge';
        this.profile = profile;
        this.preload = preload === true;
        this.view = view === 'wiki' ? 'wiki' : 'asg';
        this.readOnly = access === 'read-only' || view === 'wiki';
        this.persist = persist !== false;
        this.scorer = typeof scorer === 'function' ? scorer : null;
        this.edgeFilter = typeof edgeFilter === 'function' ? edgeFilter : null;
        this.direction = direction;
        this.hubDamping = hubDamping !== false;
        this.embedder = embedder;
        this.gate = gate;
        // 'closed': only an explicit `verdict: true` admits an edge. A gate that
        // could not calibrate returns null, and "could not decide" must not read
        // as "yes". 'open' restores the permissive reading.
        this.gatePolicy = gatePolicy === 'open' ? 'open' : 'closed';
        this.surfaces = Array.isArray(surfaces) ? surfaces : ['document'];
        /** @type {Record<string, unknown>|null} */
        this.seed = seed && typeof seed === 'object' ? seed : null;
        // 'adopted' validates against ontology.json; 'auto' derives a shape from
        // the seeded corpus and uses it for this run without adopting it.
        this.ontology = ontology === 'auto' || ontology === 'adopted' ? ontology : null;
        /** @type {{name: string, kinds: Array<string>, relations: Array<string>, version: number, proposalSha: string|null}|null} */
        this._adopted = null;
        /** @type {import('./profile.mjs').OntologyProposal|null} */
        this.proposal = null;
        this.sources = sources ?? null;
        /** @type {import('./model.mjs').KnowledgeGraph|null} */
        this._graph = graph ?? null;
        this._loaded = graph ? true : false;
        this._readOnlyReady = false;
        this._persistChain = Promise.resolve();
    }

    /**
     * The graph, hydrated from disk on first use. Never null: an absent store is
     * an empty graph, which is the normal first step rather than an error.
     * @returns {Promise<import('./model.mjs').KnowledgeGraph>}
     */
    async graph() {
        if (!this._loaded) {
            const read = this.persist ? await loadGraph({ dir: this.dir }) : null;
            this._graph = read?.status === 'ok' ? /** @type {import('./model.mjs').KnowledgeGraph} */ (read.graph) : emptyGraph({ profile: this.profile });
            this._loaded = true;
            if (this.ontology === 'adopted' && this.persist) this._adopted = await adoptedProfile({ dir: this.dir });
            if ((this._graph.nodes?.length ?? 0) === 0 && this.seed) this._ingestSeededSurfaces();
        }
        if (this.readOnly && !this._readOnlyReady) {
            const graph = /** @type {import('./model.mjs').KnowledgeGraph} */ (structuredClone(this._graph));
            const guard = validateGraph({ graph, profile: this._profileFor({ graph }), sources: this.sources, sourcePolicy: 'error' });
            if (guard.status === 'fail') {
                throw new ConfigurationError({ message: `The read-only knowledge graph validator refuses: ${guard.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.code).join(', ')}.` });
            }
            this._graph = deepFreeze({ value: graph });
            this._readOnlyReady = true;
        }
        return /** @type {import('./model.mjs').KnowledgeGraph} */ (this._graph);
    }

    /**
     * Builds the graph from the surfaces that were given a seed. Only runs when
     * the store is empty, so a resumed graph is never re-derived from stale input.
     * @returns {number} how many surfaces were ingested
     */
    _ingestSeededSurfaces() {
        let ingested = 0;
        const graph = /** @type {import('./model.mjs').KnowledgeGraph} */ (this._graph);
        const derived = this.ontology === 'auto' ? this._deriveProfile() : null;
        const profile = this.profile ?? this._adopted ?? derived?.profile ?? null;
        for (const surface of this.surfaces) {
            const input = this.seed?.[surface];
            if (input === null || input === undefined) continue;
            mergeFragment({ graph, fragment: surfaceFragment({ surface, input, profile }) });
            ingested++;
        }
        if (derived) {
            // Recorded as a proposal, never as an adoption: the graph says which
            // shape produced it and that the shape is not yet promised.
            graph.profile = derived.profile.name;
            graph.ontology = { status: 'proposed', sha: derived.proposal.sha, kinds: derived.profile.kinds.length, relations: derived.profile.relations.length };
        }
        return ingested;
    }

    /**
     * Measures the seeded documents and proposes a shape. Deterministic: the same
     * corpus yields the same proposal, which is what makes adoption reviewable.
     * @returns {{proposal: import('./profile.mjs').OntologyProposal, profile: {name: string, kinds: Array<string>, relations: Array<string>}}|null}
     */
    _deriveProfile() {
        const sources = readSeededSources({ seed: this.seed, surfaces: this.surfaces });
        if (sources.length === 0) return null;
        const proposal = proposeOntology({ profile: profileSources({ sources }) });
        this.proposal = proposal;
        return { proposal, profile: proposal.profile };
    }

    /**
     * Proposes a vocabulary for an explicit corpus, without touching the store.
     * @param {{sources?: Array<{id: string, name: string, text: string}>}} [arg0] -
     * @returns {import('./profile.mjs').OntologyProposal}
     */
    propose({ sources = [] } = {}) {
        const proposal = proposeOntology({ profile: profileSources({ sources }) });
        this.proposal = proposal;
        return proposal;
    }

    /**
     * Adopts the current (or given) proposal as the vocabulary. Versioned and
     * compare-and-swappable: this is the reviewed act that turns a measurement
     * into a promise every later graph is validated against.
     * @param {{proposal?: import('./profile.mjs').OntologyProposal|null, expected?: string|null}} arg0 -
     * @returns {Promise<{version: number, sha: string, path: string, adopted: Array<string>}>}
     */
    async adopt({ proposal = null, expected = null } = {}) {
        if (this.readOnly) throw new ConfigurationError({ message: 'Read-only knowledge does not accept ontology adoption.' });
        if (!this.persist) throw new ConfigurationError({ message: 'Non-persistent knowledge does not accept ontology adoption.' });
        const chosen = proposal ?? this.proposal;
        if (!chosen) throw new Error('adopt needs a proposal: call propose() or pass one.');
        const result = await adoptOntology({ dir: this.dir, proposal: chosen, expected });
        this._adopted = await adoptedProfile({ dir: this.dir });
        return result;
    }

    /**
     * The vocabulary this component validates against: the caller's explicit
     * profile, then the adopted ontology, then a stored graph's own shape.
     * @param {{graph?: import('./model.mjs').KnowledgeGraph|null}} arg0 -
     * @returns {import('./model.mjs').KnowledgeGraph|string|object|null|undefined}
     */
    _profileFor({ graph }) {
        return this.profile ?? this._adopted ?? undefined;
    }

    /**
     * Ingests one surface into an already-hydrated graph. The public way to add
     * data after construction; `seed` is the constructor shorthand.
     * @param {{surface?: string, input?: unknown}} arg0 -
     * @returns {Promise<{surface: string, nodes: number, edges: number}>}
     */
    async ingest({ surface = '', input = null } = /** @type {{surface?: string, input?: unknown}} */ ({})) {
        if (this.readOnly) throw new ConfigurationError({ message: 'Read-only knowledge does not accept ingestion.' });
        const graph = await this.graph();
        const before = { nodes: graph.nodes.length, edges: graph.edges.length };
        mergeFragment({ graph, fragment: surfaceFragment({ surface, input }) });
        this._graph = graph;
        return { surface, nodes: graph.nodes.length - before.nodes, edges: graph.edges.length - before.edges };
    }

    async shouldInjectStep(ctx = {}) {
        if (!this.preload) return false;
        const graph = await this.graph();
        return (graph?.nodes?.length ?? 0) > 0;
    }

    /**
     * Wiki-only mode authors nothing: the corpus is imported and read, and no
     * patch tool is registered. `withCapability` drops a null tool.
     */
    toSaveTool() {
        return this.readOnly ? null : super.toSaveTool();
    }

    /** @param {{messages?: KnowledgeRowLike[], runContext?: import('../../core/events.mjs').RunContext|null}} [ctx] */
    async stepBlock(ctx = {}) {
        const graph = await this.graph();
        if (!graph?.nodes?.length) return null;
        const text = lastUserText({ messages: ctx?.messages ?? [] });
        const result = text ? await retrieveSubgraph({ graph, text, embedder: this.embedder, scorer: this.scorer, edgeFilter: this.edgeFilter, direction: this.direction, hubDamping: this.hubDamping }) : null;
        const block = renderKnowledgeBlock({ graph, result });
        if (block) this._emit({ name: EVENTS.LOADABLE?.LOAD ?? 'knowledge:injected', payload: { nodes: result?.nodes?.length ?? 0, size: graphTextSize({ graph }) }, runContext: ctx?.runContext ?? null });
        return block;
    }

    /**
     * Query path. `page: true` returns one node's wiki view; an `id` returns its
     * neighbourhood; otherwise a ranked reading set for `query`.
     * @param {Record<string, unknown>} [args] -
     * @returns {Promise<string|null>}
     */
    async load(args = {}) {
        const graph = await this.graph();
        if (!graph?.nodes?.length) return 'The knowledge graph is empty.';
        const budget = Number.isFinite(args.budget) ? Number(args.budget) : LIMITS.knowledge_query_budget_chars;

        if (args.page && args.id) {
            const node = graph.nodes.find((/** @type {any} */ candidate) => candidate.id === args.id);
            if (!node) return `No node ${args.id}.`;
            return renderKnowledgeBlock({ graph, result: { nodes: [{ node, score: 1, similarity: 1 }], edges: [] }, budget });
        }

        if (args.id) {
            const found = queryGraph({ graph, id: String(args.id), depth: Number.isFinite(args.depth) ? Number(args.depth) : LIMITS.knowledge_query_default_depth, edgeFilter: this.edgeFilter, direction: this.direction });
            const ranked = found.nodes.map((node) => ({ node, score: 1, similarity: 1 }));
            return renderKnowledgeBlock({ graph, result: { nodes: ranked, edges: found.edges }, budget });
        }

        const result = await retrieveSubgraph({ graph, text: String(args.query ?? ''), depth: Number.isFinite(args.depth) ? Number(args.depth) : undefined, limit: LIMITS.knowledge_query_max_nodes, embedder: this.embedder, scorer: this.scorer, edgeFilter: this.edgeFilter, direction: this.direction, hubDamping: this.hubDamping });
        if (result.nodes.length === 0) return renderKnowledgeBlock({ graph, result: null, budget }) ?? 'No node matched the query.';
        return renderKnowledgeBlock({ graph, result, budget, query: String(args.query ?? '') });
    }

    /**
     * Write path: gate the authored semantic edges, apply, validate, persist,
     * render the wiki. Returns the validation envelope, not just "ok".
     * @param {{args?: Record<string, unknown>, options?: Record<string, unknown>}} arg0 -
     * @returns {Promise<{status: string, summary: {nodes: number, edges: number, errors: number, warnings: number}, findings: Array<import('./model.mjs').KnowledgeFinding>, promoted: Array<{rel: string, notes: number}>}>}
     */
    async save({ args = {} } = {}) {
        if (this.readOnly) throw new ConfigurationError({ message: 'Read-only knowledge does not accept patches.' });
        // The whole read-modify-write runs inside the serialisation chain: two
        // patches from one parallel tool round must not lose an update.
        return this._serialize(async () => {
            // One read for the whole mutation: a setLimits() landing between the
            // pre-write validation and the post-write one would otherwise report
            // a promotion that never happened.
            const promoteAfter = LIMITS.knowledge_promote_after;
            const current = await this.graph();
            const patch = await this._admit({ graph: current, patch: args });
            // Apply to a copy and validate the copy, then adopt it: a refused
            // patch must leave `graph()` and the store exactly as they were.
            const graph = structuredClone(current);
            applyPatch({ graph, patch, profile: this._profileFor({ graph }) });
            const { dir } = knowledgePaths({ dir: this.dir });
            // Validate before the write: a graph the validator refuses must not
            // reach the store, where the next sync would rebuild over it.
            const guard = validateGraph({ graph, profile: this._profileFor({ graph }), sources: this.sources, promoteAfter });
            if (guard.status === 'fail') {
                const codes = guard.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.code);
                throw new ConfigurationError({ message: `The patch produced a graph the validator refuses: ${codes.join(', ')}.` });
            }
            this._graph = graph;
            const promoted = promotableRelations({ graph, promoteAfter });
            if (this.persist) {
                const { dir } = knowledgePaths({ dir: this.dir });
                await saveGraph({ dir, graph });
                renderWiki({ graph, dir });
            }
            const validation = validateGraph({ graph, profile: this._profileFor({ graph }), sources: this.sources, wikiSha: this.persist ? readWikiSha({ dir: this.dir }) : null, promoteAfter });
            if (this.persist) await writeJsonAtomic({ filePath: join(this.dir, 'validate.json'), data: validation });
            this._emit({ name: EVENTS.LOADABLE?.SAVE ?? 'knowledge:patched', payload: { status: validation.status, nodes: validation.summary.nodes }, runContext: null });
            return { status: validation.status, summary: validation.summary, findings: validation.findings, promoted };
        });
    }

    /**
     * Decision-gate admission for agent-authored edges. A structural relation is
     * proved by a parse, so it is never gated; every other relation a patch
     * carries is. With no gate configured this is a pass-through.
     * @param {{graph?: import('./model.mjs').KnowledgeGraph|null, patch?: import('./model.mjs').KnowledgePatch|null}} arg0 -
     * @returns {Promise<import('./model.mjs').KnowledgePatch>}
     */
    async _admit({ graph = null, patch = null } = {}) {
        if (!patch) throw new Error('_admit needs a patch.');
        if (!this.gate || !Array.isArray(patch.edges) || patch.edges.length === 0) return patch;
        // The patch may introduce the very nodes its edges point at, so admission
        // must see the post-patch node set, not the pre-patch one.
        const byId = new Map([
            ...(graph?.nodes ?? []).map((/** @type {import('./model.mjs').KnowledgeNode} */ node) => /** @type {[string, any]} */ ([node.id, node])),
            ...(Array.isArray(patch.nodes) ? patch.nodes : []).map((node) => /** @type {[string, import('./model.mjs').KnowledgeNode]} */ ([node.id, node]))
        ]);
        /** @type {NonNullable<import('./model.mjs').KnowledgePatch['edges']>} */
        const kept = [];
        for (const edge of patch.edges) {
            // A caller-supplied `origin` is not evidence: an agent could claim
            // 'mechanical' to skip the gate. Every patch edge except a relation
            // a parse proved is admitted here through the gate, so a declared or
            // promoted relation is treated exactly like its `x-` form. A
            // structural relation authored in a patch stays ungated: `_admit`
            // only sees agent patches, and gating every parse-written corpus
            // edge would multiply spend. That residual is deliberate.
            const gated = !STRUCTURAL_RELATIONS.includes(String(edge?.rel ?? ''));
            if (!gated) { kept.push(edge); continue; }
            const from = byId.get(edge?.from);
            const to = byId.get(edge?.to);
            if (!from || !to) { kept.push(edge); continue; }
            const verdict = await this.gate.gate({
                state: { from: from.label, rel: edge.rel, to: to.label },
                question: { question: `Does "${from.label ?? edge.from}" ${edge.rel} "${to.label ?? edge.to}"? Answer yes or no.` }
            });
            const decision = verdict?.verdict;
            // An escalated answer is the gate saying it could not calibrate, so
            // under 'closed' it is not a yes; 'open' restores the permissive read.
            const admitted = this.gatePolicy === 'open' ? decision !== false : decision === true && verdict?.escalated !== true;
            if (!admitted) {
                this._emit({
                    name: 'knowledge:edge_rejected',
                    payload: { from: edge.from, to: edge.to, rel: edge.rel, reason: verdict?.reason ?? (decision == null ? 'gate could not decide' : 'below threshold') },
                    runContext: null
                });
                continue;
            }
            kept.push(edge);
        }
        return { ...patch, edges: kept };
    }

    /**
     * @param {() => Promise<unknown>} work -
     * @returns {Promise<unknown>}
     */
    /** @param {() => Promise<{status: string, summary: {nodes: number, edges: number, errors: number, warnings: number}, findings: Array<import('./model.mjs').KnowledgeFinding>, promoted: Array<{rel: string, notes: number}>}>} work */
    _serialize(work) {
        const next = this._persistChain.then(work, work);
        this._persistChain = next.then(() => undefined, () => undefined);
        return next;
    }
}

/**
 * @param {{profile?: string|object|null}} arg0 -
 * @returns {import('./model.mjs').KnowledgeGraph}
 */
export function emptyGraph({ profile = null } = {}) {
    const resolved = resolveProfile({ profile });
    return {
        schema: KNOWLEDGE_SCHEMA,
        version: 1,
        tool: 'knowledge',
        title: 'Knowledge graph',
        profile: resolved.name,
        profileDefinition: { name: resolved.name, kinds: [...resolved.kinds], relations: [...resolved.relations] },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sources: [],
        nodes: [],
        edges: [],
        stats: { nodes: 0, edges: 0, kinds: {}, relations: {}, coverage: 0 }
    };
}
