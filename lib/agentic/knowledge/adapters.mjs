// @ts-check
/**
 * @file Knowledge surface adapters — document, wiki corpus, memory bank, todo
 * store, plan DAG.
 * @version 0.25.0
 *
 * @description
 * One graph, many read-only surfaces. An adapter only *reads*: it materialises
 * nodes and edges from a thing the session already owns. Two rules hold across
 * all of them:
 *
 *   1. nothing is written back to the surface, so a graph can never change a
 *      todo's state or a plan's order;
 *   2. an adapter never invents meaning. The wiki importer emits structure and
 *      references only; salience is not read from front-matter, because a
 *      document must not be able to promote itself.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { buildGraph } from './build.mjs';
import { statsOf } from './model.mjs';

/**
 * Reads a text-like file. Binary formats are refused with an instruction rather
 * than decoded into noise: a bad extraction is worse than no graph.
 * @param {{path: string}} arg0 -
 * @returns {string}
 */
export function readTextFile({ path }) {
    const ext = extname(path).toLowerCase();
    if (['.docx', '.pdf', '.doc'].includes(ext)) {
        throw new Error(`${ext} needs extraction first (ingestDocument, or pdftotext/textutil); knowledge reads text files only.`);
    }
    return readFileSync(path, 'utf8');
}

/**
 * The `document` surface: one graph from one or more text files.
 * @param {{paths: Array<string>, profile?: string|null, title?: string}} arg0 -
 * @returns {import('./model.mjs').KnowledgeGraph}
 */
export function documentSurface({ paths, profile = null, title = '' }) {
    const sources = paths.map((path, index) => ({
        id: `S${index + 1}`,
        path,
        name: basename(path),
        text: readTextFile({ path })
    }));
    return buildGraph({ sources, profile, title });
}

/**
 * Markdown files under a directory, shallow enough to stay predictable.
 * @param {{dir: string}} arg0 -
 * @returns {Array<string>}
 */
function markdownFiles({ dir }) {
    /** @type {Array<string>} */
    const out = [];
    const walk = (/** @type {{current: string, depth: number}} */ { current, depth }) => {
        if (depth > 3) return;
        for (const entry of readdirSync(current)) {
            if (entry.startsWith('.')) continue;
            const full = join(current, entry);
            const info = statSync(full);
            if (info.isDirectory()) walk({ current: full, depth: depth + 1 });
            else if (extname(entry).toLowerCase() === '.md') out.push(full);
        }
    };
    walk({ current: dir, depth: 0 });
    return out.sort();
}

/**
 * The `wiki` surface: an existing markdown corpus becomes a reference graph.
 *
 * Lossy by design and one-way. It emits `contains` for headings and
 * `references` for links, and **no semantic edge** — meaning is authored
 * afterwards, which is the only place value is added. A link to a page that
 * does not exist becomes an `unresolved` edge to the source node, so an import
 * never fails validation on a dangling wikilink.
 * @param {{dir: string, profile?: string|null, title?: string}} arg0 -
 * @returns {import('./model.mjs').KnowledgeGraph}
 */
export function wikiSurface({ dir, profile = null, title = '' }) {
    const files = markdownFiles({ dir });
    /** @type {import('./model.mjs').KnowledgeNode[]} */
    const nodes = [];
    /** @type {import('./model.mjs').KnowledgeEdge[]} */
    const edges = [];
    const byStem = new Map();
    const seen = new Set();
    const unique = (/** @type {string} */ base) => {
        let id = base;
        let n = 2;
        while (seen.has(id)) id = `${base}-${n++}`;
        seen.add(id);
        return id;
    };

    for (const file of files) {
        const stem = basename(file, '.md');
        const text = readFileSync(file, 'utf8');
        const id = unique(stem);
        byStem.set(stem, id);
        const when = text.match(/^Read when:\s*(.+)$/m)?.[1]?.trim() ?? '';
        const notFor = text.match(/^Not for:\s*(.+)$/m)?.[1]?.split(/[;,]/).map((value) => value.trim()).filter(Boolean) ?? [];
        const epoch = text.match(/^Epoch:\s*(.+)$/m)?.[1]?.trim() ?? '';
        const boundaries = sectionBullets({ text, heading: 'Negative boundaries' });
        const procedure = sectionBullets({ text, heading: 'Procedure' });
        const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? stem;
        nodes.push({
            id,
            kind: 'section',
            label: heading,
            text: '',
            salience: 'scope',
            confidence: 'medium',
            // Deliberately no `salience` from front-matter: a document cannot promote itself.
            source: { sourceId: 'W', path: file, anchor: stem, line: 1 },
            terms: [],
            tags: [],
            surface: 'wiki',
            ...(when ? { when } : {}),
            ...(notFor.length ? { notFor } : {}),
            ...(epoch ? { epoch } : {}),
            ...(boundaries.length ? { boundaries } : {}),
            ...(procedure.length ? { procedure } : {})
        });
    }

    for (const file of files) {
        const stem = basename(file, '.md');
        const from = byStem.get(stem);
        if (!from) continue;
        const text = readFileSync(file, 'utf8');
        const links = new Set();
        for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) links.add(match[1].trim());
        for (const match of text.matchAll(/\]\(([^)#]+?)(?:\.md)?\)/g)) links.add(basename(match[1].trim(), '.md'));
        for (const target of links) {
            if (target === stem) continue;
            const to = byStem.get(basename(target, '.md'));
            edges.push({
                id: `E${edges.length + 1}`,
                from,
                to: to ?? from,
                rel: 'references',
                note: `link to ${target}`,
                confidence: to ? 'high' : 'low',
                origin: 'mechanical',
                surface: 'wiki',
                ...(to ? {} : { unresolved: true, targetAnchor: target })
            });
        }
    }

    return {
        schema: 'merci.knowledge/v1',
        version: 1,
        tool: 'knowledge',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: title || basename(dir),
        profile: profile ?? 'generic',
        sources: [{ id: 'W', path: dir, name: basename(dir), chars: files.reduce((sum, file) => sum + readFileSync(file, 'utf8').length, 0) }],
        nodes,
        edges,
        stats: statsOf({ nodes, edges })
    };
}

/**
 * Bullet or numbered items under one heading.
 * @param {{text: string, heading: string}} arg0 -
 * @returns {Array<string>}
 */
function sectionBullets({ text, heading }) {
    const match = text.match(new RegExp(`^##+\\s*${heading}\\s*$`, 'm'));
    if (!match || match.index === undefined) return [];
    const rest = text.slice(match.index + match[0].length);
    const stop = rest.search(/^##+\s/m);
    const block = stop === -1 ? rest : rest.slice(0, stop);
    return block.split('\n')
        .map((line) => line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/)?.[1]?.trim() ?? '')
        .filter(Boolean);
}

/**
 * The `memory` surface: bank facts become `fact` nodes. No edges are invented
 * between facts — similarity is not a relation.
 * @param {{facts: Array<{id: string, content: string, category?: string, timestamp?: number, embedding?: Array<number>}>}} arg0 -
 * @returns {{nodes: import('./model.mjs').KnowledgeNode[], edges: import('./model.mjs').KnowledgeEdge[]}}
 */
export function memorySurface({ facts }) {
    const nodes = (facts ?? []).filter((fact) => fact?.content).map((fact) => ({
        id: `F-${fact.id}`,
        kind: 'fact',
        label: String(fact.content).slice(0, 120),
        text: String(fact.content),
        salience: 'scope',
        confidence: 'medium',
        source: { sourceId: 'memory', anchor: fact.id },
        terms: [],
        tags: fact.category ? [String(fact.category)] : [],
        surface: 'memory',
        ...(fact.timestamp ? { timestamp: fact.timestamp } : {}),
        ...(Array.isArray(fact.embedding) ? { embedding: fact.embedding } : {})
    }));
    return { nodes, edges: [] };
}

/**
 * The `todos` surface: tasks and their declared dependencies.
 * @param {{store: Map<string, {id?: string, description?: string, content?: string, title?: string, status?: string, dependsOn?: string[]}>}} arg0 -
 * @returns {{nodes: import('./model.mjs').KnowledgeNode[], edges: import('./model.mjs').KnowledgeEdge[]}}
 */
export function todosSurface({ store }) {
    const list = store instanceof Map ? [...store.values()] : [];
    /** @type {import('./model.mjs').KnowledgeNode[]} */
    const nodes = [];
    /** @type {import('./model.mjs').KnowledgeEdge[]} */
    const edges = [];
    for (const todo of list) {
        if (!todo?.id) continue;
        nodes.push({
            id: `T-${todo.id}`,
            kind: 'task',
            label: String(todo.description ?? todo.content ?? todo.title ?? todo.id).slice(0, 120),
            text: '',
            salience: todo.status === 'completed' ? 'support' : 'scope',
            confidence: 'high',
            source: { sourceId: 'todos', anchor: String(todo.id) },
            terms: [],
            tags: todo.status ? [String(todo.status)] : [],
            surface: 'todos'
        });
        for (const dep of todo.dependsOn ?? []) {
            edges.push({ id: `E${edges.length + 1}`, from: `T-${todo.id}`, to: `T-${dep}`, rel: 'depends_on', note: 'todo dependency', confidence: 'high', origin: 'mechanical', surface: 'todos' });
        }
    }
    return { nodes, edges };
}

/**
 * The `plan` surface: a task DAG becomes `step` nodes. Read-only and one-way —
 * planning must never import from the knowledge graph, or a knowledge edit
 * would change execution order.
 * @param {{plan: {nodes?: Array<{id?: string, brief?: string, kind?: string, dependsOn?: string[]}>}}} arg0 -
 * @returns {{nodes: import('./model.mjs').KnowledgeNode[], edges: import('./model.mjs').KnowledgeEdge[]}}
 */
export function planSurface({ plan }) {
    const steps = Array.isArray(plan?.nodes) ? plan.nodes : [];
    /** @type {import('./model.mjs').KnowledgeNode[]} */
    const nodes = [];
    /** @type {import('./model.mjs').KnowledgeEdge[]} */
    const edges = [];
    for (const step of steps) {
        if (!step?.id) continue;
        nodes.push({
            id: `P-${step.id}`,
            kind: 'step',
            label: String(step.brief ?? step.id).slice(0, 120),
            text: '',
            salience: step.kind === 'gate' ? 'core' : 'scope',
            confidence: 'high',
            source: { sourceId: 'plan', anchor: String(step.id) },
            terms: [],
            tags: step.kind ? [String(step.kind)] : [],
            surface: 'plan'
        });
        for (const dep of step.dependsOn ?? []) {
            edges.push({ id: `E${edges.length + 1}`, from: `P-${step.id}`, to: `P-${dep}`, rel: 'depends_on', note: 'plan dependency', confidence: 'high', origin: 'mechanical', surface: 'plan' });
        }
    }
    return { nodes, edges };
}

/**
 * Runs one surface's adapter. This is what makes `surfaces` real: the component
 * calls it for each named surface that has a seed, instead of only storing the
 * list.
 * @param {{surface: string, input: unknown, profile?: string|object|null}} arg0 -
 * @returns {{nodes: Array<import('./model.mjs').KnowledgeNode>, edges: Array<import('./model.mjs').KnowledgeEdge>, sources: Array<import('./model.mjs').KnowledgeSourceRecord>}}
 */
export function surfaceFragment({ surface, input, profile = null }) {
    if (input === null || input === undefined) throw new Error(`Surface '${surface}' has no input.`);
    switch (surface) {
        case 'document': {
            const options = /** @type {{paths?: string[], profile?: string|null, title?: string}|string|string[]} */ (input);
            const surface = typeof options === 'string'
                ? { paths: [options] }
                : (Array.isArray(options) ? { paths: options } : options);
            const graph = documentSurface({ paths: surface.paths ?? [], profile: /** @type {any} */ (profile ?? surface.profile ?? null), title: surface.title ?? '' });
            return { nodes: graph.nodes, edges: graph.edges, sources: graph.sources ?? [] };
        }
        case 'wiki': {
            const options = /** @type {{dir?: string, profile?: string|null, title?: string}|string} */ (input);
            const surface = typeof options === 'string' ? { dir: options } : options;
            const graph = wikiSurface({ dir: surface.dir ?? '.', title: surface.title ?? '' });
            return { nodes: graph.nodes, edges: graph.edges, sources: graph.sources ?? [] };
        }
        case 'memory':
            return { ...memorySurface(/** @type {{facts: Array<{id: string, content: string, category?: string, timestamp?: number, embedding?: number[]}>}} */ (input)), sources: [{ id: 'memory', name: 'memory', chars: 0 }] };
        case 'todos':
            return { ...todosSurface(/** @type {{store: Map<string, {id?: string, description?: string, content?: string, title?: string, status?: string, dependsOn?: string[]}>}} */ (input)), sources: [{ id: 'todos', name: 'todos', chars: 0 }] };
        case 'plan':
            return { ...planSurface(/** @type {{plan: {nodes?: Array<{id?: string, brief?: string, kind?: string, dependsOn?: string[]}>}}} */ (input)), sources: [{ id: 'plan', name: 'plan', chars: 0 }] };
        default:
            throw new Error(`Unknown knowledge surface '${surface}'. Known: document, wiki, memory, todos, plan.`);
    }
}

/**
 * Merges adapter output into a graph, skipping ids that already exist.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null, fragment?: {nodes: Array<import('./model.mjs').KnowledgeNode>, edges: Array<import('./model.mjs').KnowledgeEdge>, sources?: Array<import('./model.mjs').KnowledgeSourceRecord>}|null}} arg0 -
 * @returns {import('./model.mjs').KnowledgeGraph}
 */
export function mergeFragment({ graph = null, fragment = null } = {}) {
    if (!graph) throw new Error('mergeFragment needs a graph.');
    const have = new Set((graph.nodes ?? []).map((node) => node.id));
    for (const node of fragment?.nodes ?? []) if (!have.has(node.id)) { graph.nodes.push(node); have.add(node.id); }
    const edges = graph.edges ?? [];
    for (const edge of fragment?.edges ?? []) {
        if (!have.has(edge.from) || !have.has(edge.to)) continue;
        edges.push({ ...edge, id: `E${edges.length + 1}` });
    }
    graph.edges = edges;
    const sources = graph.sources ?? [];
    for (const source of fragment?.sources ?? []) {
        if (!sources.some((candidate) => candidate.id === source.id)) sources.push(source);
    }
    graph.sources = sources;
    graph.stats = statsOf({ nodes: graph.nodes, edges: graph.edges });
    return graph;
}
