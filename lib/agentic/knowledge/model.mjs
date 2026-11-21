// @ts-check
/**
 * @file Knowledge graph model — node kinds, relation vocabulary, validation,
 * patching and identity. Pure: no I/O, no model calls.
 * @version 0.25.0
 *
 * @description
 * The canonical store is `graph.json`: typed `nodes` and `edges` over
 * `sources`, an abstract *semantic* graph rather than a syntax tree. The
 * relation set is fixed at a core plus a namespaced escape (`x-<label>`) that
 * must carry a `note`, so the vocabulary can grow with the content without
 * losing machine-checkable meaning.
 *
 * Two invariants carry the whole design and are enforced here, not by
 * convention:
 *   1. every node has a `source` pointer or `derived: true` (never neither);
 *   2. every semantic edge explains itself with a `note`.
 *
 * Ported from the `decompose` skill's `legalgraph/v1` (field-compatible), with
 * three additions: an `origin` marker on edges, optional evidence `tier`, and
 * the wiki-facing node attributes (`when`/`notFor`/`boundaries`/`procedure`/
 * `epoch`) that a plain graph dump cannot carry.
 */

import { createHash } from 'node:crypto';
import { LIMITS } from '../../core/limit-config.mjs';

/** Schema id carried by `graph.json`. */
export const KNOWLEDGE_SCHEMA = 'merci.knowledge/v1';

/** The schema id the legal-skills toolchain writes; accepted on import. */
export const LEGAL_GRAPH_SCHEMA = 'legalgraph/v1';

/** Current model version, bumped when a field changes meaning. */
export const KNOWLEDGE_VERSION = 1;

/**
 * A pointer to the exact place in a source a node came from.
 * @typedef {Object} KnowledgeSourceRef
 * @property {string} sourceId
 * @property {number} [start]
 * @property {number} [end]
 * @property {number} [line]
 * @property {string} [anchor]
 * @property {string} [path]
 */

/**
 * One node of the graph.
 * @typedef {Object} KnowledgeNode
 * @property {string} id
 * @property {string} kind
 * @property {string} [label]
 * @property {string} [text]
 * @property {string} [salience]
 * @property {string} [confidence]
 * @property {string} [tier]
 * @property {KnowledgeSourceRef} [source]
 * @property {boolean} [derived]
 * @property {string[]} [derivedFrom]
 * @property {string[]} [terms]
 * @property {string[]} [tags]
 * @property {string} [surface]
 * @property {string} [when]
 * @property {string[]} [notFor]
 * @property {string[]} [boundaries]
 * @property {string[]} [procedure]
 * @property {string} [epoch]
 * @property {number} [timestamp]
 * @property {number[]} [embedding]
 * @property {number} [score]
 * @property {string} [key] - content key, stable under reordering
 * @property {string[]} [headingPath] - ancestor section titles, root → nearest
 */

/**
 * One edge of the graph. `origin` says whether a parse, a formula or a
 * judgement produced it.
 * @typedef {Object} KnowledgeEdge
 * @property {string} id
 * @property {string} from
 * @property {string} to
 * @property {string} rel
 * @property {string} [note]
 * @property {string} [origin]
 * @property {number} [weight]
 * @property {string[]} [why]
 * @property {string[]} [kinds]
 * @property {string} [confidence]
 * @property {string} [surface]
 * @property {boolean} [unresolved]
 * @property {string} [targetAnchor]
 * @property {{from?: string|null, to?: string|null}} [valid]
 * @property {'positive'|'negative'} [polarity]
 * @property {string} [condition] - node id the assertion depends on
 * @property {Array<{sourceId: string, note?: string}>} [evidence]
 */

/** A source document recorded on the graph.
 * @typedef {Object} KnowledgeSourceRecord
 * @property {string} id
 * @property {string|null} [path]
 * @property {string} [name]
 * @property {number} [chars]
 * @property {string} [sha256]
 */

/** The graph envelope, as persisted to `graph.json`.
 * @typedef {Object} KnowledgeGraph
 * @property {string} [schema]
 * @property {number} [version]
 * @property {string} [tool]
 * @property {string} [title]
 * @property {string} [profile]
 * @property {{name?: string, kinds: Array<string>, relations: Array<string>}} [profileDefinition]
 * @property {string} [createdAt]
 * @property {string} [updatedAt]
 * @property {string} [sha]
 * @property {KnowledgeSourceRecord[]} sources
 * @property {KnowledgeNode[]} nodes
 * @property {KnowledgeEdge[]} edges
 * @property {{nodes?: number, edges?: number, kinds?: Record<string, number>, relations?: Record<string, number>, coverage?: number}} [stats]
 * @property {{status: string, sha: string, kinds: number, relations: number}} [ontology]
 * @property {string} [builtAt] - when the corpus cache last rebuilt it
 * @property {string} [cacheKey] - the corpus key the build was made from
 */

/** A patch the agent may write. It can add and remove, never reshape the vocabulary.
 * @typedef {Object} KnowledgePatch
 * @property {KnowledgeNode[]} [nodes]
 * @property {Array<Partial<KnowledgeEdge> & {from: string, to: string, rel: string}>} [edges]
 * @property {Array<{id: string, tags?: string[], terms?: string[], salience?: string, label?: string, confidence?: string, tier?: string, boundaries?: string[]}>} [updateNodes]
 * @property {string[]} [removeNodes]
 * @property {string[]} [removeEdges]
 * @property {string} [title]
 */

/**
 * One validation finding.
 * @typedef {Object} KnowledgeFinding
 * @property {'error'|'warning'} severity
 * @property {string} code
 * @property {string} message
 * @property {Array<string>} [ids]
 */

/** Salience ladder, most to least load-bearing. */
export const SALIENCE = Object.freeze(['core', 'scope', 'support', 'fluff']);

/** Confidence ladder. */
export const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);

/**
 * The only ids a node may carry. A wiki renderer turns an id into a filename, so
 * an id is a path segment: no separators, no traversal, no control characters.
 */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * @param {{id: unknown}} arg0 -
 * @returns {boolean}
 */
export function isSafeId({ id }) {
    return typeof id === 'string' && SAFE_ID.test(id);
}

/** Evidence tiers, from the legal corpus (`F`ull-text verified → `P`rovisional). */
export const TIERS = Object.freeze(['F', 'A', 'R', 'P']);

/** Where an edge came from: a parse, a formula, or a judgement. */
export const EDGE_ORIGINS = Object.freeze(['mechanical', 'computed', 'authored']);

/**
 * The shapes an edge may take beyond "A rel B".
 *
 * - `binary`      — the plain assertion;
 * - `negative`    — `polarity: 'negative'`: the relation is asserted *not* to
 *                   hold (a rejected defence, a boundary);
 * - `conditional` — `condition: <nodeId>`: the assertion holds only under that
 *                   condition node;
 * - `evidenced`   — `evidence: [{sourceId}]`: several sources carry one edge,
 *                   instead of one duplicate edge per source.
 *
 * A shape is a closed menu: each one costs a validator rule, a renderer rule and
 * a traversal decision, so shapes are not invented at runtime.
 */
export const EDGE_SHAPES = Object.freeze(['binary', 'negative', 'conditional', 'evidenced']);

/** The only values `edge.polarity` may take. */
export const EDGE_POLARITIES = Object.freeze(['positive', 'negative']);

/**
 * Relations a structural/doc parse or an author may use without a note.
 * `x-<label>` is the only way to add one, and it must carry a note.
 */
export const CORE_RELATIONS = Object.freeze([
    'contains', 'part_of', 'defines', 'uses', 'mentions', 'references', 'obliges',
    'permits', 'prohibits', 'grants', 'conditions', 'excepts', 'remedies',
    'duplicates', 'conflicts_with', 'depends_on', 'qualifies', 'interprets',
    'demarcates', 'inhibits', 'couples', 'supports', 'answers', 'same_as', 'derived_from'
]);

/**
 * Semantic relations assert a reading, so they need a note. A relation appears in
 * exactly one of the two classes: `depends_on` is a judgement (who says A depends
 * on B?), `defines` and `mentions` are proved by the parse. The admission gate
 * admits every non-structural relation, not only these; this list still decides
 * which relations require a note.
 */
export const SEMANTIC_RELATIONS = Object.freeze([
    'uses', 'obliges', 'permits', 'prohibits', 'grants', 'conditions',
    'excepts', 'remedies', 'duplicates', 'conflicts_with', 'qualifies',
    'interprets', 'demarcates', 'inhibits', 'couples', 'supports', 'answers',
    'same_as', 'depends_on'
]);

/** Relations that expand freely during traversal (structure, not judgement). */
export const STRUCTURAL_RELATIONS = Object.freeze(['contains', 'part_of', 'defines', 'references', 'derived_from', 'mentions']);

/**
 * @typedef {Object} KnowledgeProfile
 * @property {string} name
 * @property {ReadonlyArray<string>} kinds
 * @property {ReadonlyArray<string>} relations
 */

/** Domain-neutral vocabulary: documents, claims, evidence, work items. */
export const GENERIC_PROFILE = Object.freeze({
    name: 'generic',
    kinds: Object.freeze([
        'document', 'section', 'paragraph', 'statement', 'definition',
        'obligation', 'permission', 'prohibition', 'condition',
        'question', 'answer', 'fact', 'claim', 'evidence', 'issue', 'concept',
        'task', 'step', 'episode', 'artifact', 'note', 'source', 'boundary'
    ]),
    relations: CORE_RELATIONS
});

/** The legal vocabulary the existing corpus uses (`legalgraph/v1`). */
export const LEGAL_PROFILE = Object.freeze({
    name: 'legal',
    kinds: Object.freeze([
        'document', 'part', 'section', 'subsection', 'paragraph', 'definition',
        'obligation', 'permission', 'prohibition', 'right', 'condition',
        'exception', 'remedy', 'fact', 'issue', 'concept', 'evidence',
        'question', 'answer', 'note', 'source', 'boundary'
    ]),
    relations: CORE_RELATIONS
});

/** Every shipped profile by name. */
export const PROFILES = Object.freeze({
    [GENERIC_PROFILE.name]: GENERIC_PROFILE,
    [LEGAL_PROFILE.name]: LEGAL_PROFILE
});

/**
 * Resolves a profile by name, or accepts a caller-supplied shape.
 * @param {{profile?: string|object|null}} arg0 -
 * @returns {KnowledgeProfile}
 */
export function resolveProfile({ profile = null } = {}) {
    if (!profile) return GENERIC_PROFILE;
    if (typeof profile === 'string') {
        const found = /** @type {Record<string, KnowledgeProfile>} */ (PROFILES)[profile];
        if (!found) throw new Error(`Unknown knowledge profile '${profile}'. Known: ${Object.keys(PROFILES).join(', ')}.`);
        return found;
    }
    const shaped = /** @type {KnowledgeProfile} */ (profile);
    if (!Array.isArray(shaped.kinds) || shaped.kinds.length === 0) {
        throw new Error('A knowledge profile needs a non-empty kinds array.');
    }
    return {
        name: String(shaped.name ?? 'custom'),
        kinds: Object.freeze([...shaped.kinds]),
        relations: Object.freeze([...(shaped.relations ?? CORE_RELATIONS)])
    };
}

/**
 * @param {{profile: KnowledgeProfile, kind: string}} arg0 -
 * @returns {boolean}
 */
export function isKnownKind({ profile, kind }) {
    return profile.kinds.includes(String(kind));
}

/**
 * @param {{profile: KnowledgeProfile, rel: string}} arg0 -
 * @returns {boolean}
 */
export function isKnownRel({ profile, rel }) {
    const value = String(rel ?? '');
    return profile.relations.includes(value) || isCustomRel({ rel: value });
}

/** `x-` plus a label. `x-` alone is not a relation.
 * @param {{rel?: string}} arg0 -
 * @returns {boolean}
 */
export function isCustomRel({ rel }) {
    return /^x-\S/.test(String(rel ?? ''));
}

/**
 * @param {{rel: string}} arg0 -
 * @returns {boolean}
 */
export function isSemanticRel({ rel }) {
    const value = String(rel ?? '');
    return SEMANTIC_RELATIONS.includes(value) || isCustomRel({ rel: value });
}

/** A note must say something; `'   '` used to satisfy the custom-relation rule.
 * @param {{edge?: {note?: string}|null}} arg0 -
 * @returns {boolean}
 */
export function hasNote({ edge }) {
    return typeof edge?.note === 'string' && edge.note.trim().length > 0;
}

/**
 * The profile a stored graph declares about itself. A `legalgraph/v1` file is
 * the legal toolchain's own schema, so it is read as the legal profile even
 * though it carries no `profile` field.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null}} arg0 -
 * @returns {string|{name: string, kinds: Array<string>, relations: Array<string>}|null}
 */
export function storedProfile({ graph }) {
    // A graph built from a derived or caller-supplied shape carries the shape
    // itself. Storing only its name made the graph unable to re-validate itself:
    // `resolveProfile('derived')` knows no such name.
    const definition = graph?.profileDefinition;
    if (definition && Array.isArray(definition.kinds) && definition.kinds.length > 0) {
        return { name: String(definition.name ?? graph.profile ?? 'custom'), kinds: definition.kinds, relations: definition.relations ?? CORE_RELATIONS };
    }
    if (graph?.schema === LEGAL_GRAPH_SCHEMA) return 'legal';
    return typeof graph?.profile === 'string' && graph.profile ? graph.profile : null;
}

/**
 * Stable hash of the graph's content. `createdAt`/`stats` are excluded on
 * purpose: a re-render must not change the identity of an unchanged graph.
 * @param {{graph?: KnowledgeGraph|null}} arg0 -
 * @returns {string}
 */
export function graphSha({ graph }) {
    const payload = JSON.stringify({
        nodes: graph?.nodes ?? [],
        edges: graph?.edges ?? [],
        sources: graph?.sources ?? []
    });
    return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Counts nodes, edges, kinds and relation usage.
 * @param {{nodes: KnowledgeNode[], edges: KnowledgeEdge[]}} arg0 -
 */
export function statsOf({ nodes, edges }) {
    /** @type {Record<string, number>} */
    const kinds = {};
    /** @type {Record<string, number>} */
    const relations = {};
    for (const node of nodes) kinds[node.kind] = (kinds[node.kind] || 0) + 1;
    for (const edge of edges) relations[edge.rel] = (relations[edge.rel] || 0) + 1;
    return { nodes: nodes.length, edges: edges.length, kinds, relations, coverage: nodes.filter((node) => node.source).length };
}

/**
 * The per-node checks of `validateGraph`, in its order. Extracted so a patch
 * refuses exactly what the validator refuses; `ids` accumulates the ids seen,
 * which is how a duplicate is caught.
 * @param {{node: KnowledgeNode, ids: Set<string>, profile: KnowledgeProfile, sources?: Record<string, string>|null}} arg0 -
 * @returns {Array<KnowledgeFinding>}
 */
export function nodeErrors({ node, ids, profile, sources = null }) {
    /** @type {Array<KnowledgeFinding>} */
    const findings = [];
    if (!node?.id) findings.push({ severity: 'error', code: 'node-id', message: 'Node without id.' });
    else if (ids.has(node.id)) findings.push({ severity: 'error', code: 'node-duplicate', message: `Duplicate node id ${node.id}.`, ids: [node.id] });
    else if (!isSafeId({ id: node.id })) findings.push({ severity: 'error', code: 'node-id-unsafe', message: `Node id ${node.id} is not a safe path segment.`, ids: [node.id] });
    else ids.add(node.id);
    if (!isKnownKind({ profile, kind: node?.kind })) {
        findings.push({ severity: 'error', code: 'node-kind', message: `Unknown node kind ${node?.kind} (profile ${profile.name}).`, ids: [node?.id] });
    }
    if (!node?.label) findings.push({ severity: 'warning', code: 'node-label', message: `Node ${node?.id} has no label.`, ids: [node?.id] });
    if (!node?.source && !node?.derived) {
        findings.push({ severity: 'error', code: 'node-source', message: `Node ${node?.id} has no source pointer and is not derived.`, ids: [node?.id] });
    }
    if (node?.source && typeof node.source.sourceId !== 'string') {
        findings.push({ severity: 'error', code: 'node-source', message: `Node ${node.id} has a source with no sourceId.`, ids: [node.id] });
    }
    if (node?.derived !== undefined && typeof node.derived !== 'boolean') {
        findings.push({ severity: 'error', code: 'node-derived', message: `Node ${node.id} declares derived as ${typeof node.derived}, not a boolean.`, ids: [node.id] });
    }
    if (node?.derived && !((node.derivedFrom?.length ?? 0) > 0)) {
        findings.push({ severity: 'warning', code: 'node-derived', message: `Derived node ${node.id} names no source node.`, ids: [node.id] });
    }
    const slice = sourceSlice({ node, sources });
    if (slice !== null && typeof node?.text === 'string' && node.text && slice !== node.text) {
        findings.push({ severity: 'warning', code: 'node-roundtrip', message: `Node ${node.id} text does not match its source span.`, ids: [node.id] });
    }
    return findings;
}

/**
 * The per-edge checks of `validateGraph`, in its order. `edgeIds` accumulates
 * the ids seen, which is how a duplicate is caught.
 * @param {{edge: KnowledgeEdge, ids: Set<string>, edgeIds: Set<string>, profile: KnowledgeProfile}} arg0 -
 * @returns {Array<KnowledgeFinding>}
 */
export function edgeErrors({ edge, ids, edgeIds, profile }) {
    /** @type {Array<KnowledgeFinding>} */
    const findings = [];
    if (!edge?.id) findings.push({ severity: 'error', code: 'edge-id', message: 'Edge without id.' });
    else if (edgeIds.has(edge.id)) findings.push({ severity: 'error', code: 'edge-duplicate', message: `Duplicate edge id ${edge.id}.`, ids: [edge.id] });
    else edgeIds.add(edge.id);
    if (!ids.has(edge?.from) || !ids.has(edge?.to)) {
        findings.push({ severity: 'error', code: 'edge-endpoint', message: `Edge ${edge?.id} has a dangling endpoint.`, ids: [edge?.from, edge?.to] });
    }
    if (!isKnownRel({ profile, rel: edge?.rel })) {
        findings.push({ severity: 'error', code: 'edge-rel', message: `Edge ${edge?.id} uses unknown relation ${edge?.rel}.`, ids: [edge?.id] });
    }
    if (isCustomRel({ rel: edge?.rel }) && !hasNote({ edge })) {
        findings.push({ severity: 'error', code: 'edge-custom-note', message: `Custom edge ${edge.id} needs a note that defines the relation.`, ids: [edge.id] });
    }
    if (isSemanticRel({ rel: edge?.rel }) && !hasNote({ edge })) {
        findings.push({ severity: 'warning', code: 'edge-note', message: `Semantic edge ${edge.id} (${edge.rel}) has no note.`, ids: [edge.id] });
    }
    if (edge?.polarity !== undefined && !EDGE_POLARITIES.includes(edge.polarity)) {
        findings.push({ severity: 'error', code: 'edge-polarity', message: `Edge ${edge.id} has polarity ${edge.polarity}; expected positive or negative.`, ids: [edge.id] });
    }
    if (edge?.condition !== undefined && !ids.has(edge.condition)) {
        findings.push({ severity: 'error', code: 'edge-condition', message: `Edge ${edge.id} is conditioned on unknown node ${edge.condition}.`, ids: [edge.id] });
    }
    if (edge?.evidence !== undefined) {
        const ok = Array.isArray(edge.evidence) && edge.evidence.length > 0 && edge.evidence.every((item) => typeof item?.sourceId === 'string' && item.sourceId.length > 0);
        if (!ok) findings.push({ severity: 'error', code: 'edge-evidence', message: `Edge ${edge.id} has an evidence list without source ids.`, ids: [edge.id] });
    }
    return findings;
}

/**
 * Validates a graph. Returns findings and a `pass|warn|fail` status; never
 * throws for content problems, so a caller can gate on the result.
 * @param {{graph?: KnowledgeGraph|null, profile?: string|object|null, strict?: boolean, wikiSha?: string|null, sources?: Record<string, string>|null, promoteAfter?: number}} arg0 -
 * @returns {{schema: string, status: 'pass'|'warn'|'fail', strict: boolean, graphSha: string, summary: {nodes: number, edges: number, errors: number, warnings: number}, findings: Array<KnowledgeFinding>}}
 */
export function validateGraph({ graph = null, profile = null, strict = false, wikiSha = null, sources = null, promoteAfter = LIMITS.knowledge_promote_after } = {}) {
    const resolved = resolveProfile({ profile: profile ?? storedProfile({ graph }) });
    /** @type {Array<KnowledgeFinding>} */
    const findings = [];
    if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
        return {
            schema: `${KNOWLEDGE_SCHEMA}/validate`,
            status: 'fail',
            strict: Boolean(strict),
            graphSha: graphSha({ graph }),
            summary: { nodes: 0, edges: 0, errors: 1, warnings: 0 },
            findings: [{ severity: 'error', code: 'graph-shape', message: 'A graph needs nodes[] and edges[] arrays.' }]
        };
    }
    const nodes = graph.nodes;
    const edges = graph.edges;
    const ids = new Set();

    for (const node of nodes) findings.push(...nodeErrors({ node, ids, profile: resolved, sources }));

    const edgeIds = new Set();
    /** @type {Map<string, Set<string>>} */
    const customNotes = new Map();
    for (const edge of edges) {
        findings.push(...edgeErrors({ edge, ids, edgeIds, profile: resolved }));
        if (isCustomRel({ rel: edge?.rel }) && hasNote({ edge })) {
            const notes = customNotes.get(edge.rel) ?? new Set();
            notes.add(String(edge.note));
            customNotes.set(edge.rel, notes);
        }
    }

    for (const [rel, notes] of customNotes) {
        if (notes.size >= promoteAfter) {
            findings.push({ severity: 'warning', code: 'ontology-unpromoted', message: `Custom relation ${rel} is used in ${notes.size} distinct notes; promote it in ontology.json or split it.`, ids: [rel] });
        }
    }

    const paragraphKinds = new Set(['paragraph']);
    const contained = new Set(edges.filter((edge) => edge?.rel === 'contains').map((edge) => edge.to));
    const uncontained = nodes.filter((node) => paragraphKinds.has(node?.kind) && !contained.has(node.id));
    if (uncontained.length) {
        findings.push({ severity: 'warning', code: 'coverage', message: `${uncontained.length} paragraph(s) have no contains edge.`, ids: uncontained.slice(0, 10).map((node) => node.id) });
    }
    if ((graph?.sources ?? []).length > 1 && !edges.some((edge) => edge?.rel === 'same_as')) {
        findings.push({ severity: 'warning', code: 'multi-source', message: 'Multiple sources but no same_as edge. Link equivalent nodes or explain why not.' });
    }
    if (wikiSha && wikiSha !== graphSha({ graph })) {
        findings.push({ severity: 'warning', code: 'wiki-stale', message: 'The rendered wiki does not match the graph. Run render.' });
    }

    const errors = findings.filter((finding) => finding.severity === 'error');
    const warnings = findings.filter((finding) => finding.severity === 'warning');
    const status = errors.length ? 'fail' : (warnings.length && strict) ? 'fail' : warnings.length ? 'warn' : 'pass';
    return {
        schema: `${KNOWLEDGE_SCHEMA}/validate`,
        status,
        strict: Boolean(strict),
        graphSha: graphSha({ graph }),
        summary: { nodes: nodes.length, edges: edges.length, errors: errors.length, warnings: warnings.length },
        findings
    };
}

/**
 * The exact source text a node points at, when the caller supplied the sources.
 * @param {{node?: KnowledgeNode|null, sources: Record<string, string>|null}} arg0 -
 * @returns {string|null} `null` when unavailable, so the check is opt-in.
 */
export function sourceSlice({ node, sources }) {
    if (!sources || !node?.source) return null;
    const text = sources[node.source.sourceId];
    if (typeof text !== 'string') return null;
    const { start, end } = node.source;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return text.slice(start, end);
}

/**
 * Applies a patch: add nodes/edges, update node fields, remove by id.
 *
 * Refusals are deliberate and typed by message, because an agent writes these:
 * a dangling endpoint, an unknown kind or relation, a custom relation with no
 * note, or a patch larger than the cap is rejected before anything is written.
 * A patch can never change the vocabulary — that lives in `ontology.json`.
 * @param {{graph?: KnowledgeGraph|null, patch?: KnowledgePatch|null, profile?: string|object|null, now?: Date}} arg0 -
 * @returns {KnowledgeGraph} the same graph object, updated
 */
export function applyPatch({ graph = null, patch = null, profile = null, now = new Date() } = {}) {
    if (!graph) throw new Error('applyPatch needs a graph.');
    const resolved = resolveProfile({ profile: profile ?? storedProfile({ graph }) });
    if (!patch || typeof patch !== 'object') throw new Error('A knowledge patch must be an object.');
    const addNodes = Array.isArray(patch.nodes) ? patch.nodes : [];
    const updateNodes = Array.isArray(patch.updateNodes) ? patch.updateNodes : [];
    const cap = LIMITS.knowledge_patch_max_nodes;
    if (addNodes.length + updateNodes.length > cap) {
        throw new Error(`A knowledge patch may touch at most ${cap} nodes; this one has ${addNodes.length + updateNodes.length}.`);
    }
    const edgeCap = LIMITS.knowledge_patch_max_edges;
    const addedEdges = Array.isArray(patch.edges) ? patch.edges : [];
    if (addedEdges.length > edgeCap) {
        throw new Error(`A knowledge patch may add at most ${edgeCap} edges; this one adds ${addedEdges.length}.`);
    }

    const removeNodes = new Set(patch.removeNodes ?? []);
    const removeEdges = new Set(patch.removeEdges ?? []);
    const graphNodes = graph?.nodes ?? [];
    const graphEdges = graph?.edges ?? [];
    const nodes = graphNodes.filter((node) => !removeNodes.has(node.id));
    const edges = graphEdges.filter((edge) => !removeEdges.has(edge.id) && !removeNodes.has(edge.from) && !removeNodes.has(edge.to));
    const nodeIds = new Set(nodes.map((node) => node.id));

    for (const node of addNodes) {
        if (!node?.id) throw new Error('Every patch node needs an id.');
        if (!isSafeId({ id: node.id })) throw new Error(`Patch node id ${node.id} is not a safe path segment.`);
        if (nodeIds.has(node.id)) throw new Error(`Patch node ${node.id} already exists; use updateNodes or a new id.`);
        if (!isKnownKind({ profile: resolved, kind: node.kind })) {
            throw new Error(`Patch node ${node.id} has unknown kind ${node.kind} (profile ${resolved.name}).`);
        }
        // A patch node is agent-derived unless it carries its own source pointer.
        const merged = { derived: true, derivedFrom: [], confidence: 'medium', ...node };
        if (!merged.source && !merged.derived) throw new Error(`Patch node ${node.id} needs a source pointer or derived:true.`);
        // The validator has the last word: a patch must not persist a node that
        // `validateGraph` would refuse.
        const refused = nodeErrors({ node: merged, ids: nodeIds, profile: resolved }).find((finding) => finding.severity === 'error');
        if (refused) throw new Error(refused.message);
        nodes.push(merged);
    }

    for (const update of updateNodes) {
        const index = nodes.findIndex((candidate) => candidate.id === update.id);
        if (index < 0) throw new Error(`updateNodes names unknown node ${update.id}.`);
        // Copy, never mutate in place: a later edge rejection must leave the
        // caller's graph byte-identical.
        const node = { ...nodes[index] };
        if (update.tags) node.tags = [...new Set([...(node.tags ?? []), ...update.tags])];
        if (update.terms) node.terms = [...new Set([...(node.terms ?? []), ...update.terms])];
        if (update.salience) node.salience = update.salience;
        if (update.label) node.label = update.label;
        if (update.confidence) node.confidence = update.confidence;
        if (update.tier) node.tier = update.tier;
        if (update.boundaries) node.boundaries = [...new Set([...(node.boundaries ?? []), ...update.boundaries])];
        nodes[index] = node;
    }

    const edgeIds = new Set(edges.map((edge) => edge.id));
    for (const edge of addedEdges) {
        if (!isKnownRel({ profile: resolved, rel: edge?.rel })) throw new Error(`Patch edge uses unknown relation ${edge?.rel} (profile ${resolved.name}).`);
        if (isCustomRel({ rel: edge.rel }) && !hasNote({ edge })) throw new Error(`Custom edge ${edge.rel} needs a note that defines the relation.`);
        if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new Error(`Patch edge ${edge.from} -> ${edge.to} has a dangling endpoint.`);
        if (edge.polarity !== undefined && !EDGE_POLARITIES.includes(edge.polarity)) throw new Error(`Patch edge polarity ${edge.polarity} is not positive or negative.`);
        if (edge.condition !== undefined && !nodeIds.has(edge.condition)) throw new Error(`Patch edge is conditioned on unknown node ${edge.condition}.`);
        if (edge.evidence !== undefined) {
            const ok = Array.isArray(edge.evidence) && edge.evidence.length > 0 && edge.evidence.every((item) => typeof item?.sourceId === 'string' && item.sourceId.length > 0);
            if (!ok) throw new Error('Patch edge evidence needs at least one {sourceId}.');
        }
        // A caller's id is its identity: a collision is a mistake, not something
        // to rename behind its back. An absent id gets one.
        let id = edge.id;
        if (id === undefined) {
            id = `E${edges.length + 1}`;
            while (edgeIds.has(id)) id = `${id}b`;
        } else if (edgeIds.has(id)) {
            throw new Error(`Patch edge id ${id} already exists.`);
        }
        // Keep the caller's provenance when it names one; only an unlabelled edge
        // is the agent's own reading.
        const next = { confidence: 'medium', origin: 'authored', ...edge, id };
        // The explicit refusals above keep their wording; this is the parity
        // backstop, so a check added to `validateGraph` is also a check here.
        const refused = edgeErrors({ edge: /** @type {import('./model.mjs').KnowledgeEdge} */ (next), ids: nodeIds, edgeIds, profile: resolved }).find((finding) => finding.severity === 'error');
        if (refused) throw new Error(refused.message);
        edges.push(next);
    }

    if (patch.title) graph.title = patch.title;
    graph.schema = graph.schema ?? KNOWLEDGE_SCHEMA;
    graph.nodes = nodes;
    graph.edges = edges;
    graph.stats = statsOf({ nodes, edges });
    graph.updatedAt = now.toISOString();
    return graph;
}
