// @ts-check
/**
 * @file Corpus cache — persist a built graph, detect a delta, rebuild only what moved.
 * @version 0.27.0
 *
 * @description
 * A large corpus is expensive to read once and much more expensive to enrich.
 * The mechanical pass is cheap and deterministic; the agent's work is the part
 * worth keeping. This module makes both reusable:
 *
 *   manifest.json   the source fingerprints a build was made from
 *   graph.json      the graph itself (already the canonical store)
 *
 * `syncCorpus()` is load-or-build in one call: identical corpus and identical
 * shape means no work at all; a changed corpus rebuilds the mechanical layer and
 * **re-anchors the agent's nodes by aligning both graphs per source**, the way a
 * diff aligns two files, so enrichment survives an edit, a deletion or a move it
 * does not depend on and is dropped where its evidence is gone. A hit is
 * validated before it is trusted: a stored graph that fails is rebuilt.
 *
 * Why a content key and not the node id: ids are line-based (`S1-p-12`), so a
 * single inserted line renames every paragraph below it. `node.key` is a hash of
 * the node's own text, which is stable when the file moves around it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readStoredJson, writeJsonAtomic } from '../../support/fs-store.mjs';
import { buildGraph, nodeKey, sourceSha, KNOWLEDGE_BUILD_VERSION } from './build.mjs';
import { KNOWLEDGE_SCHEMA, edgeErrors, graphSha, nodeErrors, resolveProfile, statsOf, validateGraph } from './model.mjs';
import { DEFAULT_KNOWLEDGE_DIR, knowledgePaths, loadGraph } from './store.mjs';

/** The file that records what a build was made from. */
export const MANIFEST_FILE = 'manifest.json';

/**
 * @typedef {(arg: {sources: Array<{id: string, path?: string|null, name: string, text: string}>, profile: import('./model.mjs').KnowledgeProfile, title: string, hierarchy?: {levels?: string[], levelKinds?: Record<number, string>}|null}) => import('./model.mjs').KnowledgeGraph|Promise<import('./model.mjs').KnowledgeGraph>} KnowledgeBuilder
 */

/**
 * @typedef {{dir?: string, paths?: Array<string>, sources?: Array<{id: string, path?: string|null, name: string, text: string}>|null, profile?: string|object|null, now?: Date, hierarchy?: {levels?: string[], levelKinds?: Record<number, string>}|null}} SyncCorpusBase
 */

/**
 * @typedef {(SyncCorpusBase & {build?: undefined, buildVersion?: number})|(SyncCorpusBase & {build: KnowledgeBuilder, buildVersion: number})} SyncCorpusOptions
 */

/**
 * One source's identity: what it was called, where it lives, and what it held.
 * @typedef {Object} SourceFingerprint
 * @property {string} id
 * @property {string|null} path
 * @property {string} name
 * @property {number} chars
 * @property {string} sha256
 */

/**
 * What a build was made from.
 * @typedef {Object} CorpusManifest
 * @property {string} schema
 * @property {number} version
 * @property {string} key
 * @property {number} [buildVersion] - the extractor version the key was made with
 * @property {string} profile
 * @property {{name: string, kinds: Array<string>, relations: Array<string>, levels?: Array<string>}} [profileDefinition]
 * @property {{levels?: string[], levelKinds?: Record<number, string>}} [hierarchy]
 * @property {Array<SourceFingerprint>} sources
 * @property {{added: Array<string>, changed: Array<string>, removed: Array<string>, unchanged: Array<string>, clean: boolean}} [delta]
 * @property {{kept: number, dropped: number, droppedEdges: number}} [derived]
 * @property {string} [builtAt]
 */

/**
 * @param {{dir?: string}} [arg0] -
 * @returns {string}
 */
export function manifestPath({ dir = DEFAULT_KNOWLEDGE_DIR } = {}) {
    return join(knowledgePaths({ dir }).dir, MANIFEST_FILE);
}

/**
 * Reads the sources from disk, in the order given (the order is part of the key).
 * @param {{paths?: Array<string>}} arg0 -
 * @returns {Array<{id: string, path: string, name: string, text: string}>}
 */
export function readSources({ paths = [] } = {}) {
    return paths.map((path, index) => {
        if (!existsSync(path)) throw new Error(`Corpus source not found: ${path}`);
        const text = readFileSync(path, 'utf8');
        return { id: `S${index + 1}`, path, name: path.split('/').pop() ?? path, text };
    });
}

/**
 * @param {{sources?: Array<{id: string, path?: string|null, name?: string, text: string}>}} arg0 -
 * @returns {Array<SourceFingerprint>}
 */
export function fingerprintSources({ sources = [] } = {}) {
    return sources.map((source) => ({
        id: source.id,
        path: source.path ?? null,
        name: source.name ?? '',
        chars: String(source.text ?? '').length,
        sha256: sourceSha({ text: source.text })
    }));
}

/**
 * What changed between the corpus a graph was built from and the one on disk.
 *
 * Matched by `path` when both sides have one (a renamed file is a remove + add,
 * which is honest), otherwise by `id`.
 * @param {{stored?: Array<SourceFingerprint>, current?: Array<SourceFingerprint>}} arg0 -
 * @returns {{added: Array<string>, changed: Array<string>, removed: Array<string>, unchanged: Array<string>, clean: boolean}}
 */
export function sourceDelta({ stored = [], current = [] } = {}) {
    const keyOf = (/** @type {SourceFingerprint} */ source) => source.path ?? source.id;
    const before = new Map(stored.map((source) => [keyOf(source), source]));
    const after = new Map(current.map((source) => [keyOf(source), source]));
    /** @type {Array<string>} */
    const added = [];
    const changed = [];
    const unchanged = [];
    for (const [key, source] of after) {
        const previous = before.get(key);
        if (!previous) added.push(key);
        else if (previous.sha256 !== source.sha256) changed.push(key);
        else unchanged.push(key);
    }
    const removed = [...before.keys()].filter((key) => !after.has(key));
    return { added, changed, removed, unchanged, clean: added.length === 0 && changed.length === 0 && removed.length === 0 };
}

/**
 * The build identity: sources by path and content, plus the vocabulary that
 * shaped them and the extractor version. Two runs with the same key cannot
 * produce a different mechanical graph, which is what makes reuse safe.
 * @param {{sources?: Array<SourceFingerprint>, profile?: string|object|null, buildVersion?: number, hierarchy?: {levels?: string[], levelKinds?: Record<number, string>}|null}} arg0 -
 * @returns {string}
 */
export function corpusKey({ sources = [], profile = null, buildVersion = KNOWLEDGE_BUILD_VERSION, hierarchy = null } = {}) {
    const resolved = resolveProfile({ profile: profile ?? null });
    const declaredLevelKinds = hierarchy?.levelKinds;
    const levelKinds = declaredLevelKinds
        ? Object.keys(declaredLevelKinds).map(Number).filter((level) => Number.isFinite(level)).sort((a, b) => a - b).map((level) => [level, String(declaredLevelKinds[level])])
        : null;
    const hierarchyDescription = hierarchy && (hierarchy.levels || levelKinds)
        ? { ...(hierarchy.levels ? { levels: [...hierarchy.levels] } : {}), ...(levelKinds ? { levelKinds } : {}) }
        : null;
    const stable = JSON.stringify({
        schema: KNOWLEDGE_SCHEMA,
        buildVersion,
        profile: {
            kinds: [...resolved.kinds].sort(),
            relations: [...resolved.relations].sort(),
            ...(resolved.levels ? { levels: [...resolved.levels] } : {})
        },
        hierarchy: hierarchyDescription,
        sources: sources
            .map((source) => ({ path: source.path ?? source.id, sha256: source.sha256 }))
            .sort((a, b) => String(a.path).localeCompare(String(b.path)))
    });
    return createHash('sha256').update(stable, 'utf8').digest('hex');
}

/**
 * @param {{dir?: string}} [arg0] -
 * @returns {Promise<CorpusManifest|null>}
 */
export async function loadManifest({ dir = DEFAULT_KNOWLEDGE_DIR } = {}) {
    const read = await readStoredJson({ filePath: manifestPath({ dir }) });
    return read.status === 'ok' ? read.value : null;
}

/**
 * Loads the persisted graph and its manifest. Neither existing is normal.
 * @param {{dir?: string}} [arg0] -
 * @returns {Promise<{graph: import('./model.mjs').KnowledgeGraph|null, manifest: CorpusManifest|null}>}
 */
export async function loadCorpus({ dir = DEFAULT_KNOWLEDGE_DIR } = {}) {
    const [graphRead, manifest] = await Promise.all([loadGraph({ dir }), loadManifest({ dir })]);
    return { graph: graphRead.status === 'ok' ? /** @type {import('./model.mjs').KnowledgeGraph} */ (graphRead.graph) : null, manifest };
}

/**
 * The nodes of one source in document order — the sequence in which occurrences
 * are identified.
 * @param {{graph: any, sourceId: string}} arg0 -
 * @returns {Array<any>}
 */
function sourceSequence({ graph, sourceId }) {
    return (graph?.nodes ?? [])
        .filter((/** @type {any} */ node) => node?.source?.sourceId === sourceId)
        .map((/** @type {any} */ node) => node.key ? node : { ...node, key: nodeKey({ node }) })
        .sort((/** @type {any} */ left, /** @type {any} */ right) => Number(left.source.start) - Number(right.source.start));
}

/**
 * Groups indices of both sequences by node key.
 * @param {{stored: Array<any>, fresh: Array<any>, storedIndices: Array<number>, freshIndices: Array<number>}} arg0 -
 * @returns {Map<string, {stored: Array<number>, fresh: Array<number>}>}
 */
function groupByKey({ stored, fresh, storedIndices, freshIndices }) {
    /** @type {Map<string, {stored: Array<number>, fresh: Array<number>}>} */
    const groups = new Map();
    for (const index of storedIndices) {
        const key = stored[index].key;
        const group = groups.get(key) ?? { stored: [], fresh: [] };
        group.stored.push(index);
        groups.set(key, group);
    }
    for (const index of freshIndices) {
        const key = fresh[index].key;
        const group = groups.get(key) ?? { stored: [], fresh: [] };
        group.fresh.push(index);
        groups.set(key, group);
    }
    return groups;
}

/**
 * Keys that occur exactly once on each side, reduced to the longest run that is
 * in the same order on both. These are the diff's fixed points: everything
 * between them is aligned locally, so one edit cannot shift the rest.
 * @param {{stored: Array<any>, fresh: Array<any>}} arg0 -
 * @returns {Array<[number, number]>} stored index → fresh index, in order
 */
function uniqueAnchors({ stored, fresh }) {
    /** @type {Map<string, number>} */
    const freshIndex = new Map();
    /** @type {Map<string, number>} */
    const freshCount = new Map();
    for (let index = 0; index < fresh.length; index++) {
        const key = fresh[index].key;
        freshCount.set(key, (freshCount.get(key) ?? 0) + 1);
        freshIndex.set(key, index);
    }
    /** @type {Map<string, number>} */
    const storedCount = new Map();
    for (const node of stored) storedCount.set(node.key, (storedCount.get(node.key) ?? 0) + 1);

    /** @type {Array<[number, number]>} */
    const candidates = [];
    for (let index = 0; index < stored.length; index++) {
        const key = stored[index].key;
        if ((storedCount.get(key) ?? 0) !== 1 || (freshCount.get(key) ?? 0) !== 1) continue;
        candidates.push([index, /** @type {number} */ (freshIndex.get(key))]);
    }

    // Longest increasing subsequence of the fresh positions.
    /** @type {Array<number>} */
    const tails = [];
    /** @type {Array<number>} */
    const previous = new Array(candidates.length).fill(-1);
    for (let index = 0; index < candidates.length; index++) {
        let low = 0;
        let high = tails.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (candidates[tails[middle]][1] < candidates[index][1]) low = middle + 1;
            else high = middle;
        }
        if (low > 0) previous[index] = tails[low - 1];
        if (low === tails.length) tails.push(index);
        else tails[low] = index;
    }
    /** @type {Array<[number, number]>} */
    const anchors = [];
    let cursor = tails.length > 0 ? tails[tails.length - 1] : -1;
    while (cursor >= 0) {
        anchors.push(candidates[cursor]);
        cursor = previous[cursor];
    }
    return anchors.reverse();
}

/**
 * Maps every stored node of one source to the fresh node that is the same
 * occurrence, in four steps:
 *
 *  1. a key that occurs once on each side is an anchor;
 *  2. between anchors, same-key occurrences pair in order;
 *  3. a key left over on both sides pairs in order — the block moved;
 *  4. a surplus occurrence in a segment that still holds its key attaches to it,
 *     because the text survives even though its position does not.
 *
 * Step 4 is scoped to the segment, not the whole source: that is what stops a
 * deleted clause from borrowing an identical clause in another section.
 * @param {{stored: Array<any>, fresh: Array<any>}} arg0 -
 * @returns {Map<string, string>} stored node id → fresh node id
 */
function alignSource({ stored, fresh }) {
    /** @type {Map<string, string>} */
    const idMap = new Map();
    /** @type {Set<number>} */
    const pairedStored = new Set();
    /** @type {Set<number>} */
    const pairedFresh = new Set();

    /** @type {number} */
    let storedFrom = 0;
    /** @type {number} */
    let freshFrom = 0;

    /**
     * Pairs the two index ranges between anchors.
     * @param {{storedTo: number, freshTo: number}} arg0 -
     * @returns {void}
     */
    const alignSegment = ({ storedTo, freshTo }) => {
        /** @type {Array<number>} */
        const storedIndices = [];
        for (let index = storedFrom; index < storedTo; index++) if (!pairedStored.has(index)) storedIndices.push(index);
        /** @type {Array<number>} */
        const freshIndices = [];
        for (let index = freshFrom; index < freshTo; index++) if (!pairedFresh.has(index)) freshIndices.push(index);
        for (const group of groupByKey({ stored, fresh, storedIndices, freshIndices }).values()) {
            const count = Math.min(group.stored.length, group.fresh.length);
            for (let index = 0; index < count; index++) {
                idMap.set(stored[group.stored[index]].id, fresh[group.fresh[index]].id);
                pairedStored.add(group.stored[index]);
                pairedFresh.add(group.fresh[index]);
            }
            if (group.fresh.length === 0) continue;
            const survivorId = fresh[group.fresh[group.fresh.length - 1]].id;
            for (let index = count; index < group.stored.length; index++) {
                idMap.set(stored[group.stored[index]].id, survivorId);
                pairedStored.add(group.stored[index]);
            }
        }
        storedFrom = storedTo;
        freshFrom = freshTo;
    };

    for (const [storedIndex, freshIndex] of uniqueAnchors({ stored, fresh })) {
        alignSegment({ storedTo: storedIndex, freshTo: freshIndex });
        idMap.set(stored[storedIndex].id, fresh[freshIndex].id);
        pairedStored.add(storedIndex);
        pairedFresh.add(freshIndex);
        storedFrom = storedIndex + 1;
        freshFrom = freshIndex + 1;
    }
    alignSegment({ storedTo: stored.length, freshTo: fresh.length });

    /** @type {Array<number>} */
    const storedLeft = [];
    for (let index = 0; index < stored.length; index++) if (!pairedStored.has(index)) storedLeft.push(index);
    /** @type {Array<number>} */
    const freshLeft = [];
    for (let index = 0; index < fresh.length; index++) if (!pairedFresh.has(index)) freshLeft.push(index);
    for (const group of groupByKey({ stored, fresh, storedIndices: storedLeft, freshIndices: freshLeft }).values()) {
        const count = Math.min(group.stored.length, group.fresh.length);
        for (let index = 0; index < count; index++) idMap.set(stored[group.stored[index]].id, fresh[group.fresh[index]].id);
    }
    return idMap;
}

/**
 * Moves the agent's nodes from an old graph onto a freshly built one.
 *
 * A derived node survives when every node it declares still exists — matched by
 * **content key and document order**, not by id or position. Both graphs are
 * aligned per source the way a diff aligns two files, so an edit, a deletion or
 * a move is localised instead of shifting every anchor below it.
 *
 * A derived edge survives when both endpoints do — an endpoint is either a
 * surviving agent node or a mechanical node the alignment maps. A derived node
 * with no `derivedFrom` is the agent's own note and is kept.
 * @param {{stored?: import('./model.mjs').KnowledgeGraph|null, fresh?: import('./model.mjs').KnowledgeGraph|null}} arg0 -
 * @returns {{nodes: Array<import('./model.mjs').KnowledgeNode>, edges: Array<import('./model.mjs').KnowledgeEdge>, kept: number, dropped: number, droppedEdges: number}}
 */
export function reanchorDerived({ stored = null, fresh = null } = {}) {
    /** @type {Set<string>} */
    const sourceIds = new Set();
    for (const graph of [stored, fresh]) {
        for (const node of graph?.nodes ?? []) {
            if (node?.source?.sourceId) sourceIds.add(node.source.sourceId);
        }
    }

    /** @type {Map<string, string>} */
    const idMap = new Map();
    for (const sourceId of sourceIds) {
        const storedSequence = sourceSequence({ graph: stored, sourceId });
        const freshSequence = sourceSequence({ graph: fresh, sourceId });
        if (freshSequence.length === 0) continue;
        for (const [from, to] of alignSource({ stored: storedSequence, fresh: freshSequence })) idMap.set(from, to);
    }


    /** @type {Array<any>} */
    const nodes = [];
    let dropped = 0;
    for (const node of stored?.nodes ?? []) {
        if (!node?.derived) continue;
        const from = Array.isArray(node.derivedFrom) ? node.derivedFrom : [];
        /** @type {Array<string>} */
        const rewritten = [];
        let anchored = true;
        for (const id of from) {
            const mapped = idMap.get(id);
            if (!mapped) { anchored = false; break; }
            rewritten.push(mapped);
        }
        if (!anchored) { dropped++; continue; }
        nodes.push({ ...node, derivedFrom: rewritten, key: node.key ?? nodeKey({ node }) });
    }

    const live = new Set(nodes.map((node) => node.id));
    /** @param {string} id an endpoint as the stored graph named it */
    const resolve = (id) => (live.has(id) ? id : idMap.get(id));
    /** @type {Array<import('./model.mjs').KnowledgeEdge>} */
    const edges = [];
    let droppedEdges = 0;
    for (const edge of stored?.edges ?? []) {
        if (!edge?.origin || edge.origin === 'mechanical') continue;
        const from = resolve(edge.from);
        const to = resolve(edge.to);
        if (!from || !to) { droppedEdges++; continue; }
        edges.push({ ...edge, from, to });
    }
    return { nodes, edges, kept: nodes.length, dropped, droppedEdges };
}

/**
 * Load-or-build. The one call a large-corpus job needs.
 *
 * - the corpus and the vocabulary are unchanged → the stored graph comes back
 *   validated and untouched (`reused: true`, no rebuild, no model);
 * - a stored graph that no longer validates is not reused: it is rebuilt from
 *   the sources (`repaired: true`);
 * - anything changed → the mechanical layer is rebuilt and the agent's nodes are
 *   re-anchored by content key.
 * @param {SyncCorpusOptions} [arg0] -
 * @returns {Promise<{graph: import('./model.mjs').KnowledgeGraph, delta: {added: Array<string>, changed: Array<string>, removed: Array<string>, unchanged: Array<string>, clean: boolean}, reused: boolean, key: string, derived: {kept: number, dropped: number, droppedEdges: number}, written: boolean, repaired: boolean, validation: ReturnType<typeof validateGraph>}>}
 */
export async function syncCorpus({ dir = DEFAULT_KNOWLEDGE_DIR, paths = [], sources = null, profile = null, hierarchy = null, now = new Date(), build = buildGraph, buildVersion } = {}) {
    /** @type {Array<{id: string, path?: string|null, name?: string, text: string}>} */
    const current = /** @type {any} */ (sources) ?? readSources({ paths });
    if (current.length === 0) throw new Error('syncCorpus needs paths or sources.');
    if (typeof build !== 'function') throw new Error('syncCorpus build must be a function.');
    if (build !== buildGraph && buildVersion == null) throw new Error('A custom syncCorpus builder needs an explicit buildVersion.');
    const resolvedBuildVersion = buildVersion ?? KNOWLEDGE_BUILD_VERSION;
    const fingerprints = fingerprintSources({ sources: current });
    const resolved = resolveProfile({ profile });
    const key = corpusKey({ sources: fingerprints, profile: resolved, buildVersion: resolvedBuildVersion, hierarchy });

    const { graph: stored, manifest } = await loadCorpus({ dir });
    const delta = sourceDelta({ stored: manifest?.sources ?? [], current: fingerprints });

    /** @type {ReturnType<typeof validateGraph>|null} */
    let validation = null;
    if (stored && manifest && manifest.key === key && delta.clean) {
        validation = validateGraph({ graph: stored, profile: resolved });
        if (validation.status !== 'fail') {
            return { graph: stored, delta, reused: true, key, derived: { kept: 0, dropped: 0, droppedEdges: 0 }, written: false, repaired: false, validation };
        }
    }

    // A stored graph that failed validation is not trusted whole: keep the nodes
    // and edges that pass their own check, so one malformed field cannot destroy
    // every other agent node at the next sync.
    /** @type {import('./model.mjs').KnowledgeGraph|null} */
    let reusable = stored;
    let lost = 0;
    let lostEdges = 0;
    if (validation?.status === 'fail' && stored) {
        const ids = new Set();
        const nodes = (stored.nodes ?? []).filter((node) => nodeErrors({ node, ids, profile: resolved }).every((finding) => finding.severity !== 'error'));
        const edgeIds = new Set();
        const edges = (stored.edges ?? []).filter((edge) => edgeErrors({ edge, ids, edgeIds, profile: resolved }).every((finding) => finding.severity !== 'error'));
        lost = (stored.nodes ?? []).length - nodes.length;
        lostEdges = (stored.edges ?? []).length - edges.length;
        reusable = { ...stored, nodes, edges };
    }
    const fresh = await build({ sources: /** @type {any} */ (current), profile: resolved, title: reusable?.title ?? '', hierarchy });
    const carried = reusable ? reanchorDerived({ stored: reusable, fresh }) : { nodes: /** @type {Array<import('./model.mjs').KnowledgeNode>} */ ([]), edges: /** @type {Array<import('./model.mjs').KnowledgeEdge>} */ ([]), kept: 0, dropped: 0, droppedEdges: 0 };

    const taken = new Set(fresh.nodes.map((/** @type {any} */ node) => node.id));
    for (const node of carried.nodes) {
        if (taken.has(node.id)) continue;
        taken.add(node.id);
        fresh.nodes.push(node);
    }
    /** @type {Set<string>} */
    const edgeIds = new Set(fresh.edges.map((/** @type {any} */ edge) => edge.id));
    for (const edge of carried.edges) {
        if (!taken.has(edge.from) || !taken.has(edge.to)) continue;
        let id = edge.id;
        if (!id || edgeIds.has(id)) {
            id = `E${fresh.edges.length + 1}`;
            while (edgeIds.has(id)) id = `${id}b`;
        }
        edgeIds.add(id);
        fresh.edges.push({ ...edge, id });
    }

    fresh.sources = fingerprints;
    fresh.profile = reusable?.profile ?? fresh.profile;
    if (reusable?.profileDefinition) {
        const definition = { ...reusable.profileDefinition };
        if (resolved.levels) definition.levels = [...resolved.levels];
        else delete definition.levels;
        fresh.profileDefinition = definition;
    }
    fresh.ontology = reusable?.ontology ?? fresh.ontology;
    fresh.stats = statsOf({ nodes: fresh.nodes, edges: fresh.edges });
    fresh.updatedAt = now.toISOString();
    fresh.createdAt = reusable?.createdAt ?? fresh.createdAt;
    fresh.builtAt = now.toISOString();
    fresh.sha = graphSha({ graph: fresh });
    fresh.cacheKey = key;
    // Validate what was just written; `repaired` says the stored copy had failed.
    const report = validateGraph({ graph: fresh, profile: resolved });

    await writeJsonAtomic({ filePath: knowledgePaths({ dir }).graphPath, data: fresh });
    await writeJsonAtomic({ filePath: manifestPath({ dir }), data: {
        schema: `${KNOWLEDGE_SCHEMA}/manifest`,
        version: 1,
        key,
        buildVersion: resolvedBuildVersion,
        profile: resolved.name,
        profileDefinition: {
            name: resolved.name,
            kinds: [...resolved.kinds],
            relations: [...resolved.relations],
            ...(resolved.levels ? { levels: [...resolved.levels] } : {})
        },
        ...(hierarchy ? { hierarchy } : {}),
        sources: fingerprints,
        delta,
        derived: { kept: carried.kept, dropped: carried.dropped + lost, droppedEdges: carried.droppedEdges + lostEdges },
        builtAt: now.toISOString()
    } });
    return { graph: fresh, delta, reused: false, key, derived: { kept: carried.kept, dropped: carried.dropped + lost, droppedEdges: carried.droppedEdges + lostEdges }, written: true, repaired: validation !== null, validation: report };
}
