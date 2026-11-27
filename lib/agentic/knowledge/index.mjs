// @ts-check
/**
 * @file Public surface of the knowledge capability (ASG + wiki).
 * @version 0.25.0
 *
 * @description
 * One canonical graph, two projections. The ASG is the store; the wiki is a
 * generated view of it. Import a markdown corpus to bootstrap, then author
 * typed edges on top.
 *
 * @example
 * import { KnowledgeComponent, buildGraph, validateGraph } from 'merci-sdk/knowledge';
 * const graph = buildGraph({ sources: [{ id: 'S1', name: 'nda.md', text }] });
 * const report = validateGraph({ graph });
 * graph.nodes.length; // …
 */

export {
    KNOWLEDGE_SCHEMA,
    LEGAL_GRAPH_SCHEMA,
    KNOWLEDGE_VERSION,
    EDGE_SHAPES,
    EDGE_POLARITIES,
    SALIENCE,
    CONFIDENCE,
    TIERS,
    EDGE_ORIGINS,
    CORE_RELATIONS,
    SEMANTIC_RELATIONS,
    STRUCTURAL_RELATIONS,
    GENERIC_PROFILE,
    LEGAL_PROFILE,
    PROFILES,
    resolveProfile,
    levelKindsFor,
    isKnownKind,
    isKnownRel,
    isSemanticRel,
    graphSha,
    statsOf,
    validateGraph,
    applyPatch,
    sourceSlice
} from './model.mjs';

export {
    normalizeText,
    headingList,
    paragraphList,
    sentenceList,
    modalityOf,
    extractDefinitions,
    extractRefs,
    buildGraph,
    nodeKey,
    sourceSha,
    KNOWLEDGE_BUILD_VERSION,
    slug,
    keyOf
} from './build.mjs';

export {
    HIERARCHY_RELATIONS,
    hierarchyOf,
    hierarchyPath
} from './hierarchy.mjs';

export {
    DEFAULT_KNOWLEDGE_DIR,
    knowledgePaths,
    loadGraph,
    saveGraph,
    loadOntology,
    saveOntology,
    promotableRelations,
    adoptOntology,
    adoptedProfile
} from './store.mjs';

export {
    tokensOf,
    bm25Scores,
    lexicalScore,
    salienceWeight,
    confidenceWeight,
    tierWeight,
    hubDivisor,
    rankNodes,
    seedNodes,
    expandSubgraph,
    queryGraph,
    retrieveSubgraph
} from './query.mjs';

export {
    graphTextSize,
    renderSectionMap,
    renderKnowledgeBlock,
    renderNodePage,
    renderWiki,
    readWikiSha,
    edgeText
} from './render.mjs';

export {
    readTextFile,
    surfaceFragment,
    documentSurface,
    wikiSurface,
    memorySurface,
    todosSurface,
    planSurface,
    mergeFragment
} from './adapters.mjs';

export { profileSources, proposeOntology, ontologySha, AGENT_KINDS } from './profile.mjs';

export {
    MANIFEST_FILE,
    manifestPath,
    readSources,
    fingerprintSources,
    sourceDelta,
    corpusKey,
    loadManifest,
    loadCorpus,
    reanchorDerived,
    syncCorpus
} from './cache.mjs';

export { KnowledgeComponent, emptyGraph } from './component.mjs';
