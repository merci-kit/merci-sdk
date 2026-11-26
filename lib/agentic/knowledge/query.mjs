// @ts-check
/**
 * @file Knowledge retrieval — seed, expand, rank.
 * @version 0.25.0
 *
 * @description
 * Turns a query into a *bounded* subgraph. Three seed channels (lexical,
 * optional vector, explicit ids) feed a traversal that expands structural
 * edges freely and semantic edges once, then a ranking that damps hubs.
 *
 * The hub damping is the point. A `document` node is reachable from everything,
 * so an undamped score returns the map instead of the answer. The divisor is
 * logarithmic rather than `1/(1+degree)`: a literal reciprocal would make
 * degree dominate similarity and bury a legitimately central node.
 *
 * Nothing here calls a model. The embedder, when supplied, is the same
 * `embedder({ input })` seam `withMemory` binds.
 */

import { LIMITS } from '../../core/limit-config.mjs';
import { STRUCTURAL_RELATIONS } from './model.mjs';

const STOPWORDS = new Set(('a an the this that these those it its they them their he she his her we us our you your and or but nor so yet for if then than as at by from in into of off on onto out over per to up upon via with within without under above below between among during before after since until while when where which who whom whose what how why whether not no only also such any all each every both either neither some more most other same own few many much several here there now thus hence therefore however moreover furthermore additionally finally firstly secondly lastly').split(' '));

/**
 * One ranked node with the score that placed it.
 * @typedef {Object} RankedNode
 * @property {import('./model.mjs').KnowledgeNode} node
 * @property {number} score
 * @property {number} similarity
 */

/**
 * @typedef {(arg: {graph: import('./model.mjs').KnowledgeGraph|null|undefined, nodes: import('./model.mjs').KnowledgeNode[], text: string, ids: string[], query: string[]}) => Map<string, number>} KnowledgeScorer
 */

/**
 * @typedef {(edge: import('./model.mjs').KnowledgeEdge) => boolean} KnowledgeEdgeFilter
 */

/**
 * @param {{text: string, normalize?: 'none'|'fold', ngrams?: number, stopwords?: ReadonlySet<string>}} arg0 -
 * @returns {Array<string>}
 */
export function tokensOf({ text, normalize = 'none', ngrams = 1, stopwords = STOPWORDS }) {
    const value = String(text ?? '')
        .replace(/[’']/g, "'");
    const folded = normalize === 'fold'
        ? value.normalize('NFD').replace(/\p{Diacritic}/gu, '')
        : value;
    const tokens = folded
        .toLowerCase()
        .split(/[^\p{L}\p{N}']+/u)
        .filter((token) => token.length > 1 && !stopwords.has(token));
    const size = Math.max(1, Number.isInteger(ngrams) ? ngrams : 1);
    if (size === 1) return tokens;
    const out = [...tokens];
    for (let width = 2; width <= size; width++) {
        for (let index = 0; index + width <= tokens.length; index++) {
            out.push(tokens.slice(index, index + width).join(' '));
        }
    }
    return out;
}

/**
 * BM25 scores aligned with `documents`. Strings use the default tokenizer;
 * callers that need folding or n-grams pass token arrays from `tokensOf`.
 * @param {{documents: Array<Array<string>|string>, query: Array<string>|string, k1?: number, b?: number}} arg0 -
 * @returns {number[]}
 */
export function bm25Scores({ documents = [], query, k1 = 1.2, b = 0.75 }) {
    const docs = documents.map((document) => Array.isArray(document) ? document : tokensOf({ text: document }));
    const terms = Array.isArray(query) ? query : tokensOf({ text: query });
    if (!docs.length || terms.length === 0) return docs.map(() => 0);
    const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
    const df = new Map();
    for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
    const total = docs.length;
    return docs.map((doc) => {
        const counts = new Map();
        for (const term of doc) counts.set(term, (counts.get(term) ?? 0) + 1);
        let score = 0;
        for (const term of terms) {
            const tf = counts.get(term) ?? 0;
            if (!tf) continue;
            const idf = Math.log(1 + (total - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
            score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + b * (doc.length / average)));
        }
        return score;
    });
}

/**
 * Overlap score in [0, 1]: how much of the query the node covers.
 * @param {{query: Array<string>, text: string}} arg0 -
 * @returns {number}
 */
export function lexicalScore({ query, text }) {
    if (query.length === 0) return 0;
    const have = new Set(tokensOf({ text }));
    if (have.size === 0) return 0;
    let hit = 0;
    for (const token of query) if (have.has(token)) hit++;
    return hit / query.length;
}

/**
 * @param {{a: Array<number>, b: Array<number>}} arg0 -
 * @returns {number}
 */
function cosine({ a, b }) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * @param {{node?: import('./model.mjs').KnowledgeNode|null}} arg0 -
 * @returns {number}
 */
export function salienceWeight({ node }) {
    switch (node?.salience) {
        case 'core': return 1;
        case 'scope': return 0.8;
        case 'support': return 0.5;
        case 'fluff': return 0.15;
        default: return 0.7;
    }
}

/**
 * @param {{node?: import('./model.mjs').KnowledgeNode|null}} arg0 -
 * @returns {number}
 */
export function confidenceWeight({ node }) {
    switch (node?.confidence) {
        case 'high': return 1;
        case 'low': return 0.5;
        case 'medium': return 0.8;
        default: return 0.8;
    }
}

/**
 * Evidence tier, keeping the corpus's hedging in the ranking.
 * @param {{node?: import('./model.mjs').KnowledgeNode|null}} arg0 -
 * @returns {number}
 */
export function tierWeight({ node }) {
    switch (node?.tier) {
        case 'F': return 1;
        case 'A': return 0.8;
        case 'R': return 0.6;
        case 'P': return 0.3;
        default: return 1;
    }
}

/**
 * @param {{indegree: number}} arg0 -
 * @returns {number}
 */
export function hubDivisor({ indegree }) {
    return 1 + Math.log(1 + Math.max(0, indegree));
}

/**
 * Ranks candidates by similarity, salience, confidence and tier, damped by
 * inbound degree unless the caller supplies an already-calibrated ranking.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null, candidates?: import('./model.mjs').KnowledgeNode[], similarity?: Map<string, number>, limit?: number, hubDamping?: boolean, tiePriority?: ReadonlySet<string>|null}} arg0 -
 * @returns {Array<RankedNode>}
 */
export function rankNodes({ graph = null, candidates = [], similarity = new Map(), limit = LIMITS.knowledge_query_max_nodes, hubDamping = true, tiePriority = null } = {}) {
    const indegree = new Map();
    for (const edge of graph?.edges ?? []) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    const ranked = candidates.map((node) => {
        const sim = similarity.get(node.id) ?? 0;
        const divisor = hubDamping ? hubDivisor({ indegree: indegree.get(node.id) ?? 0 }) : 1;
        const score = (sim * salienceWeight({ node }) * confidenceWeight({ node }) * tierWeight({ node })) / divisor;
        return { node, score, similarity: sim };
    });
    ranked.sort((a, b) => (b.score - a.score)
        || Number(Boolean(tiePriority?.has(b.node.id))) - Number(Boolean(tiePriority?.has(a.node.id)))
        || String(a.node.id).localeCompare(String(b.node.id)));
    return ranked.slice(0, limit);
}

/**
 * Picks seed nodes from three channels. Explicit ids win; lexical runs on
 * label + text + terms; the embedder, when present, adds cosine similarity.
 * A caller scorer returns a Map<id, score>; its positive maximum is normalised
 * to 1 before fusion so BM25 or another scale cannot drown explicit-id hits.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null, text?: string, ids?: Array<string>, embedder?: Function|null, limit?: number, scorer?: KnowledgeScorer|null}} arg0 -
 * @returns {Promise<{seeds: Array<string>, similarity: Map<string, number>, scoredIds: Array<string>}>}
 */
export async function seedNodes({ graph, text = '', ids = [], embedder = null, limit = 12, scorer = null } = {}) {
    const byId = new Map((graph?.nodes ?? []).map((node) => /** @type {[string, import('./model.mjs').KnowledgeNode]} */ ([node.id, node])));
    /** @type {Map<string, number>} */
    const similarity = new Map();
    /** @type {Array<string>} */
    const seeds = [];
    const add = (/** @type {{id: string, score: number}} */ { id, score }) => {
        if (!byId.has(id)) return;
        similarity.set(id, Math.max(similarity.get(id) ?? 0, score));
        if (!seeds.includes(id)) seeds.push(id);
    };

    for (const id of ids) add({ id: String(id), score: 1 });

    const query = tokensOf({ text });
    if (query.length > 0) {
        /** @type {Array<{id: string, score: number}>} */
        const lexical = [];
        for (const node of graph?.nodes ?? []) {
            const haystack = `${node.label ?? ''} ${node.text ?? ''} ${(node.terms ?? []).join(' ')} ${(node.tags ?? []).join(' ')}`;
            const score = lexicalScore({ query, text: haystack });
            if (score > 0) lexical.push({ id: node.id, score });
        }
        lexical.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
        for (const hit of lexical.slice(0, limit)) add({ id: hit.id, score: hit.score });
    }

    if (embedder && query.length > 0) {
        try {
            const vector = await embedder({ input: text });
            for (const node of graph?.nodes ?? []) {
                if (!Array.isArray(node.embedding)) continue;
                const score = cosine({ a: vector, b: node.embedding });
                if (score > 0) add({ id: node.id, score: Math.max(similarity.get(node.id) ?? 0, score) });
            }
        } catch {
            // An embedder failure degrades to lexical recall; it never fails the query.
        }
    }

    const scorerIds = new Set();
    const scoredIds = [];
    if (scorer) {
        const scored = await scorer({ graph, nodes: graph?.nodes ?? [], text, ids, query });
        if (!(scored instanceof Map)) throw new Error('A knowledge scorer must return a Map of node id to score.');
        let maximum = 0;
        for (const [id, value] of scored) {
            if (byId.has(id) && Number.isFinite(value) && value > maximum) maximum = value;
        }
        for (const [id, value] of scored) {
            if (byId.has(id) && Number.isFinite(value) && value > 0) {
                scorerIds.add(id);
                scoredIds.push(id);
                add({ id, score: value / maximum });
            }
        }
    }

    const uniqueSeeds = [...new Set(seeds)];
    const orderedSeeds = scorer
        ? uniqueSeeds.sort((left, right) => {
            const byScore = (similarity.get(right) ?? 0) - (similarity.get(left) ?? 0);
            return byScore || Number(scorerIds.has(right)) - Number(scorerIds.has(left));
        })
        : uniqueSeeds;
    return { seeds: orderedSeeds.slice(0, limit), similarity, scoredIds };
}

/**
 * Bounded BFS. Structural edges expand freely; a semantic edge is followed once
 * per node, so one judgement cannot pull in a whole neighbourhood. `edgeFilter`
 * must be a pure predicate; it runs before adjacency is built and again when
 * surviving edges are returned. Edge `weight` has no built-in meaning.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null, seeds?: Array<string>, depth?: number, maxNodes?: number, depths?: Map<string, number>|null, edgeFilter?: KnowledgeEdgeFilter|null, direction?: 'both'|'outgoing'|'incoming'}} arg0 -
 * @returns {Array<string>}
 */
export function expandSubgraph({ graph = null, seeds = [], depth = LIMITS.knowledge_query_default_depth, maxNodes = LIMITS.knowledge_query_max_nodes, depths = null, edgeFilter = null, direction = 'both' } = {}) {
    if (!['both', 'outgoing', 'incoming'].includes(direction)) throw new Error(`Unknown traversal direction '${direction}'.`);
    const maxDepth = Math.min(depth, LIMITS.knowledge_query_max_depth);
    const adjacency = new Map();
    for (const edge of graph?.edges ?? []) {
        if (edgeFilter && !edgeFilter(edge)) continue;
        if (direction !== 'incoming') {
            if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
            adjacency.get(edge.from).push({ edge, other: edge.to });
        }
        if (direction !== 'outgoing') {
            if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
            adjacency.get(edge.to).push({ edge, other: edge.from });
        }
    }
    // The cap applies to the seeds too: a caller that passes more seeds than the
    // cap got more nodes than it asked for.
    const capped = [...new Set(seeds)].slice(0, Math.max(1, maxNodes));
    for (const id of capped) if (depths) depths.set(id, 0);
    const seen = new Set(capped);
    const semanticUsed = new Set();
    let frontier = [...capped];
    for (let level = 0; level < maxDepth && frontier.length > 0 && seen.size < maxNodes; level++) {
        const next = [];
        for (const current of frontier) {
            for (const { edge, other } of adjacency.get(current) ?? []) {
                if (seen.has(other)) continue;
                const structural = STRUCTURAL_RELATIONS.includes(edge.rel);
                if (!structural) {
                    if (semanticUsed.has(current)) continue;
                    semanticUsed.add(current);
                }
                seen.add(other);
                if (depths) depths.set(other, level + 1);
                next.push(other);
                if (seen.size >= maxNodes) break;
            }
            if (seen.size >= maxNodes) break;
        }
        frontier = next;
    }
    return [...seen];
}

/**
 * The bounded neighbourhood of one node, for the explicit-id query form.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null, id?: string, depth?: number, maxNodes?: number, edgeFilter?: KnowledgeEdgeFilter|null, direction?: 'both'|'outgoing'|'incoming'}} arg0 -
 * @returns {{node: import('./model.mjs').KnowledgeNode, nodes: import('./model.mjs').KnowledgeNode[], edges: Array<import('./model.mjs').KnowledgeEdge>}}
 */
export function queryGraph({ graph = null, id = '', depth = 1, maxNodes = LIMITS.knowledge_query_max_nodes, edgeFilter = null, direction = 'both' } = {}) {
    if (!['both', 'outgoing', 'incoming'].includes(direction)) throw new Error(`Unknown traversal direction '${direction}'.`);
    const byId = new Map((graph?.nodes ?? []).map((node) => /** @type {[string, import('./model.mjs').KnowledgeNode]} */ ([node.id, node])));
    const node = byId.get(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    const maxDepth = Math.min(depth, LIMITS.knowledge_query_max_depth);
    const cap = Math.max(1, maxNodes);
    const seen = new Set([id]);
    let frontier = [id];
    /** @type {import('./model.mjs').KnowledgeEdge[]} */
    const edges = [];
    for (let level = 0; level < maxDepth && frontier.length > 0 && seen.size < cap; level++) {
        const next = [];
        for (const current of frontier) {
            for (const edge of graph?.edges ?? []) {
                if (edgeFilter && !edgeFilter(edge)) continue;
                let other = null;
                if (direction !== 'incoming' && edge.from === current) other = edge.to;
                if (direction !== 'outgoing' && edge.to === current) other = edge.from;
                if (other === null) continue;
                if (!edges.includes(edge)) edges.push(edge);
                if (seen.has(other)) continue;
                seen.add(other);
                next.push(other);
                if (seen.size >= cap) break;
            }
            if (seen.size >= cap) break;
        }
        frontier = next;
    }
    return { node, nodes: /** @type {import('./model.mjs').KnowledgeNode[]} */ ([...seen].map((nodeId) => byId.get(nodeId)).filter(Boolean)), edges: edges.filter((edge) => seen.has(edge.from) && seen.has(edge.to)) };
}

/**
 * The whole read path: seed → expand → rank. Returns the ranked nodes plus
 * every edge whose both ends survived.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null, text?: string, ids?: Array<string>, embedder?: Function|null, depth?: number, limit?: number, scorer?: KnowledgeScorer|null, edgeFilter?: KnowledgeEdgeFilter|null, direction?: 'both'|'outgoing'|'incoming', hubDamping?: boolean}} arg0 -
 * @returns {Promise<{nodes: Array<RankedNode>, edges: import('./model.mjs').KnowledgeEdge[], seeds: Array<string>}>}
 */
export async function retrieveSubgraph({ graph, text = '', ids = [], embedder = null, depth, limit, scorer = null, edgeFilter = null, direction = 'both', hubDamping = true } = {}) {
    const maxNodes = limit ?? LIMITS.knowledge_query_max_nodes;
    const { seeds, similarity, scoredIds } = await seedNodes({ graph, text, ids, embedder, scorer });
    if (seeds.length === 0) return { nodes: [], edges: [], seeds: [] };
    const idSet = new Set(seeds);
    const cappedSeeds = seeds.filter((id) => idSet.has(id)).slice(0, maxNodes);
    /** @type {Map<string, number>} */
    const depths = new Map();
    const idsInScope = new Set(expandSubgraph({ graph, seeds: cappedSeeds, depth, maxNodes, depths, edgeFilter, direction }));
    // A node reached through structure inherits a decayed seed score. Without it
    // every expanded node scored 0 and the "ranking" was an id sort.
    const bestSeed = Math.max(0, ...cappedSeeds.map((id) => similarity.get(id) ?? 0));
    for (const id of idsInScope) {
        if (similarity.has(id)) continue;
        similarity.set(id, bestSeed * Math.pow(0.5, Math.max(1, depths.get(id) ?? 1)));
    }
    const candidates = (graph?.nodes ?? []).filter((node) => idsInScope.has(node.id));
    const ranked = rankNodes({ graph, candidates, similarity, limit: maxNodes, hubDamping, tiePriority: new Set(scoredIds) });
    const keep = new Set(ranked.map((entry) => entry.node.id));
    const edges = (graph?.edges ?? []).filter((edge) => keep.has(edge.from) && keep.has(edge.to) && (!edgeFilter || edgeFilter(edge)));
    return { nodes: ranked, edges, seeds };
}
