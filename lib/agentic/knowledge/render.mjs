// @ts-check
/**
 * @file Knowledge rendering — the prompt block and the wiki projection.
 * @version 0.25.0
 *
 * @description
 * Two projections of one graph, and they are not interchangeable.
 *
 * The *block* is what the model reads each step: a section map, the ranked
 * nodes, and each surviving edge with its note. It is prose, never JSON, and it
 * is budgeted — "do not paste the whole graph" is a correctness rule, not a
 * style preference.
 *
 * The *wiki* is what a human reads: one markdown page per node plus an index
 * that carries the graph hash, so a stale render is a validation finding
 * instead of a silent divergence.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LIMITS } from '../../core/limit-config.mjs';
import { COGNITIVE_MEMORY_PROMPTS, escapeUntrustedFence } from '../../core/prompts.mjs';
import { graphSha, isSafeId } from './model.mjs';
import { hierarchyOf, hierarchyPath } from './hierarchy.mjs';

/**
 * Writes text atomically enough for a regenerable artefact.
 * @param {{filePath: string, content: string}} arg0 -
 */
function writeText({ filePath, content }) {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, filePath);
}

/**
 * Total characters of node text — the size signal the budget tiers read.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null}} arg0 -
 * @returns {number}
 */
export function graphTextSize({ graph = null } = {}) {
    let total = 0;
    for (const node of graph?.nodes ?? []) total += String(node.text ?? '').length;
    return total;
}

/**
 * The text form of an edge, shared by the prompt block and the wiki so the two
 * cannot drift. Negative and conditional assertions are marked, and a multi
 * source edge says how many.
 * @param {{edge: import('./model.mjs').KnowledgeEdge|null, target: string, arrow: '→'|'←'}} arg0 -
 * @returns {string}
 */
export function edgeText({ edge, target, arrow }) {
    const negated = edge?.polarity === 'negative';
    const rel = `${negated ? '¬' : ''}${edge?.rel ?? ''}`;
    const parts = [`${rel} ${arrow} [${target}]`];
    if (edge?.condition) parts.push(`only when [${edge.condition}]`);
    if (edge?.note) parts.push(`— ${oneLine({ value: edge.note })}`);
    if (Array.isArray(edge?.evidence) && edge.evidence.length > 1) parts.push(`(${edge.evidence.length} sources)`);
    return parts.join(' ');
}

/**
 * One-line label, collapsed whitespace and fenced: a label, text or `when` that
 * carries `</untrusted_knowledge>` must not be able to end the block's fence.
 * @param {{value: unknown}} arg0 -
 * @returns {string}
 */
function oneLine({ value }) {
    return escapeUntrustedFence({ value: String(value ?? '').replace(/\s+/g, ' ').trim() });
}

/**
 * Selects one structural relation for display. `contains` wins when both are
 * present; graphs without either keep the kind-based map fallback.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null, maxNodes?: number}} arg0
 * @returns {import('./hierarchy.mjs').HierarchyTree|null}
 */
function selectedHierarchy({ graph = null, maxNodes = Number.MAX_SAFE_INTEGER } = {}) {
    const edges = graph?.edges ?? [];
    const rel = edges.some((edge) => edge.rel === 'contains') ? 'contains'
        : edges.some((edge) => edge.rel === 'part_of') ? 'part_of' : null;
    return rel ? hierarchyOf({ graph, rel, maxNodes }) : null;
}

/**
 * The map: hierarchy when structural edges justify it, headings when the graph
 * has them, otherwise the most load-bearing nodes.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null, budget?: number}} arg0 -
 * @returns {string|null}
 */
export function renderSectionMap({ graph = null, budget = LIMITS.knowledge_query_budget_chars } = {}) {
    const nodes = graph?.nodes ?? [];
    if (nodes.length === 0) return null;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const tree = selectedHierarchy({ graph });
    const limit = Math.max(160, budget);
    if (tree) {
        const structuralKinds = new Set([
            'document', 'section', 'subsection', 'part', 'book', 'chapter', 'article',
            ...(tree.levels ?? graph?.profileDefinition?.levels ?? []),
            ...Object.values(tree.levelKinds ?? {})
        ]);
        const mapIds = new Set(tree.nodes.filter((entry) => {
            const node = byId.get(entry.id);
            return node && (structuralKinds.has(node.kind) || (entry.children.length > 0 && !node.text && node.kind !== 'paragraph'));
        }).map((entry) => entry.id));
        const lines = ['Section map:'];
        let spent = lines[0].length;
        let printed = 0;
        const seen = new Set();
        const stack = [...tree.roots].reverse();
        let remaining = 0;
        let truncated = tree.truncated;
        while (true) {
            if (stack.length === 0) {
                while (remaining < tree.ordered.length && seen.has(tree.ordered[remaining])) remaining++;
                if (remaining >= tree.ordered.length) break;
                stack.push(tree.ordered[remaining++]);
            }
            const id = stack.pop();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const entry = tree.byId.get(id);
            const node = byId.get(id);
            if (!entry || !node) continue;
            for (let index = entry.primaryChildren.length - 1; index >= 0; index--) stack.push(entry.primaryChildren[index]);
            if (!mapIds.has(id)) continue;
            const line = `${'  '.repeat(entry.depth)}- [${id}] ${oneLine({ value: node.label })}`;
            if (spent + line.length + 1 > limit) {
                truncated = true;
                break;
            }
            lines.push(line);
            spent += line.length + 1;
            printed++;
        }
        if (printed < mapIds.size) truncated = true;
        if (truncated) lines.push('- …');
        return lines.join('\n');
    }

    const sections = nodes.filter((node) => node.kind === 'section' || node.kind === 'part');
    const source = sections.length > 0
        ? sections
        : [...nodes]
            .filter((node) => node.kind !== 'document')
            .sort((a, b) => (salienceRank({ node: a }) - salienceRank({ node: b })) || String(a.id).localeCompare(String(b.id)))
            .slice(0, 40);
    if (source.length === 0) return null;

    const lines = [sections.length > 0 ? 'Section map:' : 'Graph map:'];
    let spent = lines[0].length;
    for (const node of source) {
        const line = `- [${node.id}] ${oneLine({ value: node.label })}`;
        if (spent + line.length > limit) break;
        lines.push(line);
        spent += line.length + 1;
    }
    return lines.length > 1 ? lines.join('\n') : null;
}

/** @param {{node: import('./model.mjs').KnowledgeNode}} arg0 - */
function salienceRank({ node }) {
    switch (node?.salience) {
        case 'core': return 0;
        case 'scope': return 1;
        case 'support': return 2;
        case 'fluff': return 3;
        default: return 2;
    }
}

/**
 * Renders a bounded knowledge block for the prompt.
 *
 * Returns `null` when there is nothing worth injecting, so a step adds no row
 * at all. With no ranked nodes it still renders the section map: that is the
 * cold-start path when no seed matched.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null, result?: {nodes: Array<{node: import('./model.mjs').KnowledgeNode, score: number, similarity: number}>, edges: Array<import('./model.mjs').KnowledgeEdge>}|null, budget?: number, query?: string}} arg0 -
 * @returns {string|null}
 */
export function renderKnowledgeBlock({ graph = null, result = null, budget = LIMITS.knowledge_query_budget_chars, query = '' } = {}) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    if (nodes.length === 0) return null;
    // Hoisted: one read per call, so a setLimits() landing mid-render cannot
    // size the block with one tier and render it with another.
    const splitAt = LIMITS.knowledge_split_chars;
    const mapAt = LIMITS.knowledge_section_map_chars;
    const size = graphTextSize({ graph });
    const limit = Math.max(200, budget);

    if (size > splitAt) {
        const map = renderSectionMap({ graph, budget: limit });
        if (!map) return null;
        return withHeader({ body: map, graph, hint: 'This graph is large. Query it by id; do not request the whole graph.' });
    }

    const ranked = result?.nodes ?? [];
    const hierarchy = ranked.length > 0 ? selectedHierarchy({ graph }) : null;
    const map = size > mapAt || ranked.length === 0 ? renderSectionMap({ graph, budget: limit }) : null;
    if (ranked.length === 0) {
        if (!map) return null;
        return withHeader({ body: map, graph, hint: 'No seed matched this turn. Read the map, then query a node by id.' });
    }

    const outgoing = new Map();
    for (const edge of result?.edges ?? []) {
        if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
        outgoing.get(edge.from).push(edge);
    }

    /** @type {Array<string>} */
    const body = [];
    if (map) body.push(map, '');
    body.push(query ? `Ranked for: ${oneLine({ value: query })}` : 'Ranked nodes:');
    let spent = body.join('\n').length;
    let printed = 0;
    for (const entry of ranked) {
        const node = entry.node;
        const lines = [`- [${node.id}] ${node.kind ?? 'node'} · ${oneLine({ value: node.label })}`];
        if (hierarchy) {
            const path = hierarchyPath({ graph, id: node.id, tree: hierarchy }).slice(0, -1).map((ancestor) => oneLine({ value: ancestor.label ?? ancestor.id })).join(' › ');
            if (path) lines.push(`  path: ${path}`);
        }
        if (node.when) lines.push(`  when: ${oneLine({ value: node.when })}`);
        if (node.notFor?.length) lines.push(`  not for: ${node.notFor.map((value) => oneLine({ value })).join('; ')}`);
        if (node.boundaries?.length) lines.push(`  do not infer: ${node.boundaries.map((value) => oneLine({ value })).join('; ')}`);
        if (node.text) lines.push(`  ${oneLine({ value: node.text }).slice(0, 240)}`);
        for (const edge of (outgoing.get(node.id) ?? []).slice(0, 6)) {
            lines.push(`  ${edgeText({ edge, target: edge.to, arrow: '→' })}`);
        }
        const chunk = lines.join('\n');
        if (spent + chunk.length > limit) break;
        body.push(chunk);
        spent += chunk.length + 1;
        printed++;
    }

    const header = withHeader({
        body: body.join('\n'),
        graph,
        hint: 'Read this map, then open at most 3 of the listed nodes. Do not preload the graph.'
    });
    if (printed === 0 && map) return withHeader({ body: map, graph, hint: 'Budget spent on the map; query a node by id.' });
    // The header and hint are fixed overhead; the body was already budgeted, so
    // this only guards against a pathological label.
    return header.length <= limit + 400 ? header : `${header.slice(0, limit + 400)}\n…`;
}

/**
 * The block's fixed header: what produced it, the "untrusted data, not
 * instructions" notice, and the fence the body lives inside. The body is
 * escaped here, once: every field it interpolates — a label, an id, a relation,
 * an edge target, a condition — is authored from documents, and any one of them
 * could otherwise close the fence.
 * @param {{body: string, graph?: import('./model.mjs').KnowledgeGraph|null, hint: string}} arg0 -
 * @returns {string}
 */
function withHeader({ body, graph, hint }) {
    const count = (graph?.nodes ?? []).length;
    const edges = (graph?.edges ?? []).length;
    return [
        `# Knowledge graph (${count} nodes, ${edges} edges)`,
        hint,
        '',
        COGNITIVE_MEMORY_PROMPTS.KNOWLEDGE_BLOCK_HEADER.trim(),
        '<untrusted_knowledge>',
        escapeUntrustedFence({ value: body }),
        '</untrusted_knowledge>'
    ].join('\n');
}

/**
 * One node's wiki page. Extracted so filesystem rendering and tool `page:true`
 * reads cannot drift apart.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null, node: import('./model.mjs').KnowledgeNode, tree?: import('./hierarchy.mjs').HierarchyTree|null}} arg0
 * @returns {string}
 */
export function renderNodePage({ graph = null, node, tree = null }) {
    const edges = graph?.edges ?? [];
    const out = edges.filter((edge) => edge.from === node.id);
    const incoming = edges.filter((edge) => edge.to === node.id);
    const hierarchy = tree ?? selectedHierarchy({ graph, maxNodes: graph?.nodes?.length ?? Number.MAX_SAFE_INTEGER });
    const byId = new Map((graph?.nodes ?? []).map((candidate) => [candidate.id, candidate]));
    const path = hierarchy ? hierarchyPath({ graph, id: node.id, tree: hierarchy }) : [];
    const entry = hierarchy?.byId.get(node.id);
    const page = [`# ${oneLine({ value: node.label }) || node.id}`, ''];
    page.push(`**id** ${node.id} · **kind** ${node.kind ?? '—'} · **salience** ${node.salience ?? '—'} · **confidence** ${node.confidence ?? '—'}${node.tier ? ` · **tier** ${node.tier}` : ''}`);
    if (path.length > 0) page.push('', `**Path** ${path.map((ancestor) => oneLine({ value: ancestor.label ?? ancestor.id })).join(' › ')}`);
    if (entry?.parent) {
        const parent = byId.get(entry.parent);
        if (parent) page.push('', `**Up** ${nodeRef({ node: parent })}`);
    }
    if (entry && entry.parents.length > 1) {
        page.push('', '## Also in', '');
        for (const id of entry.parents.slice(1)) {
            const parent = byId.get(id);
            if (parent) page.push(`- ${nodeRef({ node: parent })}`);
        }
    }
    if (entry?.children.length) {
        page.push('', '## Children', '');
        for (const id of entry.children) {
            const child = byId.get(id);
            if (child) page.push(`- ${nodeRef({ node: child })}`);
        }
    }
    if (node.when) page.push('', `**Read when** ${oneLine({ value: node.when })}`);
    if (node.notFor?.length) page.push('', `**Not for** ${node.notFor.map((value) => oneLine({ value })).join(', ')}`);
    if (node.epoch) page.push('', `**Epoch** ${oneLine({ value: node.epoch })}`);
    if (node.source) page.push('', `**source** ${node.source.sourceId}${node.source.anchor ? `#${node.source.anchor}` : ''}${node.source.line ? `:${node.source.line}` : ''}`);
    if (node.text) page.push('', '## Text', '', node.text);
    if (node.boundaries?.length) page.push('', '## Negative boundaries', '', ...node.boundaries.map((value) => `- ${oneLine({ value })}`));
    if (node.procedure?.length) page.push('', '## Procedure', '', ...node.procedure.map((value, /** @type {number} */ index) => `${index + 1}. ${oneLine({ value })}`));
    if (node.derived) page.push('', `**Derived from** ${(node.derivedFrom ?? []).join(', ') || '—'}`);
    if (node.tags?.length) page.push('', `**tags** ${node.tags.join(', ')}`);
    page.push('', '## Outgoing', '');
    if (out.length === 0) page.push('None.');
    for (const edge of out) page.push(`- ${edgeText({ edge, target: edge.to, arrow: '→' })}`);
    page.push('', '## Incoming', '');
    if (incoming.length === 0) page.push('None.');
    for (const edge of incoming) page.push(`- ${edgeText({ edge, target: edge.from, arrow: '←' })}`);
    page.push('');
    return page.join('\n');
}

/** @param {{node: import('./model.mjs').KnowledgeNode}} arg0 */
function nodeRef({ node }) {
    const label = oneLine({ value: node.label ?? node.id });
    return isSafeId({ id: node.id }) ? `[${label}](${node.id}.md)` : label;
}

/**
 * Renders the wiki. Pages whose own content did not change are left alone, so a
 * 600-page corpus is not rewritten on every edit; the index always is, because
 * it carries the graph hash.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null, dir?: string}} arg0 -
 * @returns {{dir: string, dirWritten: string, pages: number, sha: string}}
 */
export function renderWiki({ graph = null, dir = '.knowledge' } = {}) {
    const wiki = join(dir, 'wiki');
    const sha = graphSha({ graph });
    const byId = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));
    const tree = selectedHierarchy({ graph, maxNodes: graph?.nodes?.length ?? Number.MAX_SAFE_INTEGER });
    /** @param {import('./model.mjs').KnowledgeNode} node */
    const pathCell = (node) => tree
        ? hierarchyPath({ graph, id: node.id, tree }).map((ancestor) => ancestor.label ?? ancestor.id).join(' › ')
        : '';
    let written = 0;

    const indexLines = [
        `<!-- graph-sha256: ${sha} -->`,
        `# ${oneLine({ value: graph?.title }) || 'Knowledge graph'} — semantic graph`,
        '',
        `${(graph?.nodes ?? []).length} nodes · ${(graph?.edges ?? []).length} edges · ${(graph?.sources ?? []).length} source(s) · profile ${graph?.profile ?? 'generic'}`,
        '',
        '## Sources',
        '',
        '| id | name | chars |',
        '|---|---|---|'
    ];
    for (const source of graph?.sources ?? []) indexLines.push(`| ${source.id} | ${cell({ value: source.name })} | ${source.chars ?? ''} |`);
    indexLines.push('', '## Nodes', '', tree ? '| id | kind | path | salience | label |' : '| id | kind | salience | label |', tree ? '|---|---|---|---|---|' : '|---|---|---|---|');
    for (const node of graph?.nodes ?? []) {
        if (!isSafeId({ id: node.id })) {
            indexLines.push(tree
                ? `| ${node.id} | ${node.kind ?? ''} | ${cell({ value: pathCell(node) })} | ${node.salience ?? ''} | ${cell({ value: node.label })} (unsafe id, not rendered) |`
                : `| ${node.id} | ${node.kind ?? ''} | ${node.salience ?? ''} | ${cell({ value: node.label })} (unsafe id, not rendered) |`);
            continue;
        }
        indexLines.push(tree
            ? `| [${node.id}](nodes/${node.id}.md) | ${node.kind ?? ''} | ${cell({ value: pathCell(node) })} | ${node.salience ?? ''} | ${cell({ value: node.label })} |`
            : `| [${node.id}](nodes/${node.id}.md) | ${node.kind ?? ''} | ${node.salience ?? ''} | ${cell({ value: node.label })} |`);
    }
    indexLines.push('', '## Edges', '', 'See [edges.md](edges.md). The relation set is open: `x-*` must carry a note.', '');
    writeText({ filePath: join(wiki, 'index.md'), content: indexLines.join('\n') });

    for (const node of graph?.nodes ?? []) {
        // Defence in depth: an id becomes a filename, so an unsafe one is skipped
        // rather than written. `validateGraph` reports it as `node-id-unsafe`.
        if (!isSafeId({ id: node.id })) continue;
        const content = renderNodePage({ graph, node, tree });
        const filePath = join(wiki, 'nodes', `${node.id}.md`);
        if (!existsSync(filePath) || readFileSync(filePath, 'utf8') !== content) {
            writeText({ filePath, content });
            written++;
        }
    }

    // A removed node must not leave a page behind: the index would stop linking
    // it and the claim "one page per node" quietly becomes "one page per node
    // ever seen".
    const pagesDir = join(wiki, 'nodes');
    const live = new Set((graph?.nodes ?? []).filter((node) => isSafeId({ id: node.id })).map((node) => `${node.id}.md`));
    if (existsSync(pagesDir)) {
        for (const name of readdirSync(pagesDir)) {
            if (!name.endsWith('.md') || live.has(name)) continue;
            rmSync(join(pagesDir, name), { force: true });
        }
    }

    const edgeLines = ['# Edges', '', '| id | from | rel | to | shape | origin | confidence | note |', '|---|---|---|---|---|---|---|---|'];
    for (const edge of graph?.edges ?? []) {
        const shape = edge.polarity === 'negative' ? 'negative' : (edge.condition ? 'conditional' : (Array.isArray(edge.evidence) && edge.evidence.length > 1 ? 'evidenced' : 'binary'));
        edgeLines.push(`| ${edge.id} | ${edge.from}${byId.has(edge.from) ? '' : ' (missing)'} | ${edge.rel} | ${edge.to}${byId.has(edge.to) ? '' : ' (missing)'} | ${shape} | ${edge.origin ?? ''} | ${edge.confidence ?? ''} | ${cell({ value: edge.note ?? '' })} |`);
    }
    edgeLines.push('');
    writeText({ filePath: join(wiki, 'edges.md'), content: edgeLines.join('\n') });

    const hierarchyEdges = tree
        ? (graph?.edges ?? []).filter((edge) => edge.rel === tree.rel && byId.has(edge.from) && byId.has(edge.to))
        : [];
    const participants = new Set(hierarchyEdges.flatMap((edge) => [edge.from, edge.to]));
    const sections = (tree
        ? (graph?.nodes ?? []).filter((node) => participants.has(node.id))
        : (graph?.nodes ?? []).filter((node) => node.kind === 'section' || node.kind === 'subsection'))
        .slice(0, LIMITS.knowledge_wiki_max_section_nodes);
    const sectionIds = new Set(sections.map((node) => node.id));
    const mmd = ['graph TD'];
    for (const node of sections) mmd.push(`  ${safe({ value: node.id })}["${oneLine({ value: node.label }).replace(/"/g, "'").slice(0, 60)}"]`);
    for (const edge of graph?.edges ?? []) {
        if (tree && edge.rel !== tree.rel) continue;
        if (!sectionIds.has(edge.from) || !sectionIds.has(edge.to)) continue;
        mmd.push(`  ${safe({ value: edge.from })} -->|${edge.rel}| ${safe({ value: edge.to })}`);
    }
    writeText({ filePath: join(wiki, 'graph.mmd'), content: `${mmd.join('\n')}\n` });

    return { dir: wiki, dirWritten: wiki, pages: written, sha };
}

/**
 * The graph hash a previously rendered wiki carries, or null.
 * @param {{dir?: string}} arg0 -
 * @returns {string|null}
 */
export function readWikiSha({ dir = '.knowledge' } = {}) {
    const filePath = join(dir, 'wiki', 'index.md');
    if (!existsSync(filePath)) return null;
    const match = readFileSync(filePath, 'utf8').match(/graph-sha256:\s*([0-9a-f]{64})/);
    return match ? match[1] : null;
}

/** @param {{value: unknown}} arg0 - */
function cell({ value }) {
    return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

/** @param {{value: unknown}} arg0 - */
function safe({ value }) {
    return String(value ?? '').replace(/[^A-Za-z0-9_]/g, '_');
}
