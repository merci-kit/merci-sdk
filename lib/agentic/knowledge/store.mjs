// @ts-check
/**
 * @file Knowledge store — the canonical `graph.json` and the separate
 * `ontology.json`.
 * @version 0.25.0
 *
 * @description
 * Two files, on purpose. `graph.json` is the instance data and changes on every
 * enrichment; `ontology.json` is the vocabulary and changes only by review. A
 * graph edit must never be able to reshape the schema, so they never share a
 * writer.
 *
 * Persistence reuses the repo's durable-JSON primitive: atomic write, strict
 * read, and a corrupt file is reported rather than healed over.
 */

import { join } from 'node:path';
import { LIMITS } from '../../core/limit-config.mjs';
import { readStoredJson, writeJsonAtomic } from '../../support/fs-store.mjs';
import { KNOWLEDGE_SCHEMA, KNOWLEDGE_VERSION, PROFILES, CORE_RELATIONS, graphSha } from './model.mjs';

/** Default directory, matching the `.knowledge` convention of the skill corpus. */
export const DEFAULT_KNOWLEDGE_DIR = '.knowledge';

/**
 * @param {{dir?: string}} arg0 -
 * @returns {{dir: string, graphPath: string, ontologyPath: string}}
 */
export function knowledgePaths({ dir = DEFAULT_KNOWLEDGE_DIR } = {}) {
    return {
        dir,
        graphPath: join(dir, 'graph.json'),
        ontologyPath: join(dir, 'ontology.json')
    };
}

/**
 * Loads the graph. A missing file is `{ status: 'missing' }`, not an error: an
 * empty store is the normal first step.
 * @param {{dir?: string}} arg0 -
 * @returns {Promise<{status: 'ok'|'missing'|'corrupt', graph?: import('./model.mjs').KnowledgeGraph, reason?: string}>}
 */
export async function loadGraph({ dir = DEFAULT_KNOWLEDGE_DIR } = {}) {
    const { graphPath } = knowledgePaths({ dir });
    const read = await readStoredJson({ filePath: graphPath });
    if (read.status !== 'ok') return { status: /** @type {'missing'|'corrupt'} */ (read.status), reason: read.reason };
    const graph = read.value;
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        return { status: 'corrupt', reason: 'graph.json has no nodes/edges arrays' };
    }
    return { status: 'ok', graph };
}

/**
 * Writes the graph and stamps its stats + hash.
 * @param {{dir?: string, graph: import('./model.mjs').KnowledgeGraph}} arg0 -
 * @returns {Promise<string>} the path written
 */
export async function saveGraph({ dir = DEFAULT_KNOWLEDGE_DIR, graph }) {
    const { graphPath } = knowledgePaths({ dir });
    graph.schema = graph.schema ?? KNOWLEDGE_SCHEMA;
    graph.version = graph.version ?? KNOWLEDGE_VERSION;
    graph.updatedAt = new Date().toISOString();
    graph.sha = graphSha({ graph });
    await writeJsonAtomic({ filePath: graphPath, data: graph });
    return graphPath;
}

/**
 * Loads the vocabulary. Absent means "the profile's own vocabulary".
 * @param {{dir?: string}} arg0 -
 * @returns {Promise<{kinds: Array<string>, relations: Array<string>, promoted: Array<string>, version: number, status: string, proposalSha: string|null}>}
 */
export async function loadOntology({ dir = DEFAULT_KNOWLEDGE_DIR } = {}) {
    const { ontologyPath } = knowledgePaths({ dir });
    const read = await readStoredJson({ filePath: ontologyPath });
    const value = read.status === 'ok' ? read.value : null;
    return {
        kinds: Array.isArray(value?.kinds) ? value.kinds : [],
        relations: Array.isArray(value?.relations) ? value.relations : [...CORE_RELATIONS],
        promoted: Array.isArray(value?.promoted) ? value.promoted : [],
        version: Number(value?.version ?? 0),
        status: typeof value?.status === 'string' ? value.status : 'authored',
        proposalSha: typeof value?.proposalSha === 'string' ? value.proposalSha : null
    };
}

/**
 * Writes the vocabulary. Separate entry point because it is a separate review.
 * @param {{dir?: string, ontology: {kinds?: Array<string>, relations?: Array<string>, promoted?: Array<string>}}} arg0 -
 * @returns {Promise<string>}
 */
export async function saveOntology({ dir = DEFAULT_KNOWLEDGE_DIR, ontology }) {
    const { ontologyPath } = knowledgePaths({ dir });
    await writeJsonAtomic({ filePath: ontologyPath, data: {
        schema: `${KNOWLEDGE_SCHEMA}/ontology`,
        version: 1,
        profile: Object.keys(PROFILES).join(','),
        kinds: ontology.kinds ?? [],
        relations: ontology.relations ?? [...CORE_RELATIONS],
        promoted: ontology.promoted ?? [],
        updatedAt: new Date().toISOString()
    } });
    return ontologyPath;
}

/**
 * Adopts a proposal as the vocabulary. The gate is deliberate: a proposal is a
 * measurement, an adopted ontology is a promise every later graph is validated
 * against, so it is versioned and it can be compare-and-swapped.
 *
 * `expected` is the sha the caller saw. When it does not match the current
 * adoption, the write is refused rather than silently replacing a newer one.
 * @param {{dir?: string, proposal?: import('./profile.mjs').OntologyProposal|null, expected?: string|null, now?: Date}} [arg0] -
 * @returns {Promise<{version: number, sha: string, path: string, adopted: Array<string>}>}
 */
export async function adoptOntology({ dir = DEFAULT_KNOWLEDGE_DIR, proposal = null, expected = null, now = new Date() } = /** @type {{dir?: string, proposal?: import('./profile.mjs').OntologyProposal|null, expected?: string|null, now?: Date}} */ ({})) {
    if (!proposal?.profile || !Array.isArray(proposal.profile.kinds)) {
        throw new Error('adoptOntology needs a proposal with a profile.');
    }
    const cap = LIMITS.knowledge_propose_max_kinds;
    if (proposal.profile.kinds.length > cap) {
        throw new Error(`A derived profile may carry at most ${cap} kinds; this proposal has ${proposal.profile.kinds.length}.`);
    }
    const current = await loadOntology({ dir });
    if (expected !== null && expected !== undefined && current.proposalSha && current.proposalSha !== expected) {
        throw new Error(`The adopted ontology changed since you read it (expected ${expected}, found ${current.proposalSha}).`);
    }
    const { ontologyPath } = knowledgePaths({ dir });
    const version = (current.version ?? 0) + 1;
    await writeJsonAtomic({ filePath: ontologyPath, data: {
        schema: `${KNOWLEDGE_SCHEMA}/ontology`,
        version,
        status: 'adopted',
        name: proposal.profile.name ?? 'derived',
        profile: proposal.profile,
        shapes: proposal.shapes ?? ['binary'],
        evidence: { kinds: proposal.kinds, relations: proposal.relations },
        proposalSha: proposal.sha ?? null,
        adoptedAt: now.toISOString()
    } });
    return { version, sha: proposal.sha ?? '', path: ontologyPath, adopted: proposal.profile.kinds };
}

/**
 * The adopted vocabulary as a profile a graph can be validated against, or
 * null when nothing was adopted.
 * @param {{dir?: string}} [arg0] -
 * @returns {Promise<{name: string, kinds: Array<string>, relations: Array<string>, levels?: Array<string>, version: number, proposalSha: string|null}|null>}
 */
export async function adoptedProfile({ dir = DEFAULT_KNOWLEDGE_DIR } = {}) {
    const read = await readStoredJson({ filePath: knowledgePaths({ dir }).ontologyPath });
    if (read.status !== 'ok') return null;
    const value = read.value;
    if (value?.status !== 'adopted' || !Array.isArray(value?.profile?.kinds) || value.profile.kinds.length === 0) return null;
    return {
        name: String(value.profile.name ?? 'derived'),
        kinds: value.profile.kinds,
        relations: Array.isArray(value.profile.relations) ? value.profile.relations : [...CORE_RELATIONS],
        ...(Array.isArray(value.profile.levels) ? { levels: value.profile.levels } : {}),
        version: Number(value.version ?? 1),
        proposalSha: value.proposalSha ?? null
    };
}

/**
 * Custom relations that appear in enough distinct notes to deserve promotion
 * into the vocabulary. Reported, never auto-applied: promoting a relation is a
 * reviewed act.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null, promoteAfter: number}} arg0 -
 * @returns {Array<{rel: string, notes: number}>}
 */
export function promotableRelations({ graph, promoteAfter }) {
    /** @type {Map<string, Set<string>>} */
    const notes = new Map();
    for (const edge of graph?.edges ?? []) {
        if (!String(edge?.rel ?? '').startsWith('x-') || !edge?.note) continue;
        const set = notes.get(edge.rel) ?? new Set();
        set.add(String(edge.note));
        notes.set(edge.rel, set);
    }
    return [...notes.entries()]
        .filter(([, set]) => set.size >= promoteAfter)
        .map(([rel, set]) => ({ rel, notes: set.size }))
        .sort((a, b) => b.notes - a.notes);
}
