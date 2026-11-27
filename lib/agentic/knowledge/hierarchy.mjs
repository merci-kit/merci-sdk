// @ts-check
/**
 * @file Read-only hierarchy derivation for knowledge graphs.
 *
 * Parent/child links, depth and order are projections of edges. They are never
 * written back to nodes, so the same graph can be read as a forest, a DAG or a
 * cycle without making the stored representation lie.
 */

import { LIMITS } from '../../core/limit-config.mjs';

/** Relations whose direction can describe containment. */
export const HIERARCHY_RELATIONS = Object.freeze(['contains', 'part_of']);

/**
 * @typedef {Object} HierarchyDescription
 * @property {ReadonlyArray<string>} [levels]
 * @property {Record<number, string>} [levelKinds]
 */

/**
 * @typedef {Object} HierarchyEntry
 * @property {string} id
 * @property {string|null} parent
 * @property {string[]} parents
 * @property {string[]} children
 * @property {string[]} primaryChildren
 * @property {number} depth
 * @property {number} order
 * @property {boolean} shared
 * @property {boolean} cycle
 */

/**
 * @typedef {Object} HierarchyTree
 * @property {string} rel
 * @property {HierarchyEntry[]} nodes
 * @property {Map<string, HierarchyEntry>} byId
 * @property {string[]} roots
 * @property {string[]} ordered
 * @property {string[][]} cycles
 * @property {Array<{edgeId: string, from: string, to: string, missing: string[]}>} missing
 * @property {boolean} truncated
 * @property {number} maxNodes
 * @property {ReadonlyArray<string>|undefined} [levels]
 * @property {Record<number, string>|undefined} [levelKinds]
 */

/**
 * @typedef {Object} HierarchySortEntry
 * @property {string} id
 * @property {number|null} start
 * @property {number} sourceOrder
 * @property {number} edgeOrder
 * @property {number} nodeOrder
 */

/** @param {{left: number, right: number}} arg0 */
function compareNumber({ left, right }) {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

/** @param {{left: string, right: string}} arg0 */
function compareText({ left, right }) {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

/** @param {{left: HierarchySortEntry, right: HierarchySortEntry}} arg0 */
function compareOrder({ left, right }) {
    return compareNumber({ left: left.start ?? Number.POSITIVE_INFINITY, right: right.start ?? Number.POSITIVE_INFINITY })
        || compareNumber({ left: left.sourceOrder, right: right.sourceOrder })
        || compareNumber({ left: left.edgeOrder, right: right.edgeOrder })
        || compareNumber({ left: left.nodeOrder, right: right.nodeOrder })
        || compareText({ left: left.id, right: right.id });
}

/**
 * Derives a bounded hierarchy from `contains` (parent → child) or `part_of`
 * (child → parent) edges. Missing endpoints are reported and ignored; cycles
 * are retained and marked instead of recursively expanded.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null, rel?: string, maxNodes?: number}} arg0
 * @returns {HierarchyTree}
 */
export function hierarchyOf({ graph = null, rel = 'contains', maxNodes = LIMITS.knowledge_query_max_nodes } = {}) {
    const relation = HIERARCHY_RELATIONS.includes(rel) ? rel : 'contains';
    const graphNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const graphEdges = Array.isArray(graph?.edges) ? graph.edges : [];
    const nodeById = new Map();
    const nodeOrder = new Map();
    for (let index = 0; index < graphNodes.length; index++) {
        const node = graphNodes[index];
        if (!node || typeof node.id !== 'string' || nodeById.has(node.id)) continue;
        nodeById.set(node.id, node);
        nodeOrder.set(node.id, index);
    }
    const sources = graph?.sources ?? [];
    const sourceOrder = new Map();
    for (let index = 0; index < sources.length; index++) {
        const source = sources[index];
        if (source && typeof source.id === 'string' && !sourceOrder.has(source.id)) sourceOrder.set(source.id, index);
    }
    /** @param {{id: string, edgeOrder?: number}} arg0 */
    const sortEntry = ({ id, edgeOrder = Number.POSITIVE_INFINITY }) => {
        const node = nodeById.get(id);
        const start = node?.source?.start;
        return {
            id,
            start: Number.isFinite(start) ? Number(start) : null,
            sourceOrder: sourceOrder.get(node?.source?.sourceId) ?? Number.POSITIVE_INFINITY,
            edgeOrder,
            nodeOrder: nodeOrder.get(id) ?? Number.POSITIVE_INFINITY
        };
    };

    /** @type {Array<{edgeId: string, from: string, to: string, missing: string[]}>} */
    const missing = [];
    /** @type {Map<string, Map<string, number>>} */
    const parentEdges = new Map();
    /** @type {Map<string, Map<string, number>>} */
    const childEdges = new Map();
    for (let index = 0; index < graphEdges.length; index++) {
        const edge = graphEdges[index];
        if (!edge || edge.rel !== relation) continue;
        const parent = relation === 'part_of' ? edge.to : edge.from;
        const child = relation === 'part_of' ? edge.from : edge.to;
        const absent = [];
        if (!nodeById.has(parent)) absent.push(parent);
        if (!nodeById.has(child)) absent.push(child);
        if (absent.length > 0) {
            missing.push({ edgeId: String(edge.id ?? index), from: String(edge.from), to: String(edge.to), missing: absent });
            continue;
        }
        const parentsForChild = parentEdges.get(child) ?? new Map();
        parentEdges.set(child, parentsForChild);
        if (!parentsForChild.has(parent)) parentsForChild.set(parent, index);
        const childrenForParent = childEdges.get(parent) ?? new Map();
        childEdges.set(parent, childrenForParent);
        if (!childrenForParent.has(child)) childrenForParent.set(child, index);
    }

    const ordered = [...nodeById.keys()].map((id) => sortEntry({ id })).sort((left, right) => compareOrder({ left, right })).map((entry) => entry.id);
    const requested = Number.isFinite(maxNodes) ? Math.max(0, Math.trunc(Number(maxNodes))) : ordered.length;
    const cap = Math.min(ordered.length, requested);
    const included = new Set(ordered.slice(0, cap));
    const truncated = cap < ordered.length;
    /** @type {Map<string, HierarchyEntry>} */
    const byId = new Map();
    for (const id of ordered) {
        if (!included.has(id)) continue;
        const parents = [...(parentEdges.get(id)?.keys() ?? [])]
            .filter((parent) => included.has(parent))
            .map((parent) => sortEntry({ id: parent, edgeOrder: parentEdges.get(id)?.get(parent) ?? Number.POSITIVE_INFINITY }))
            .sort((left, right) => compareOrder({ left, right }))
            .map((entry) => entry.id);
        const children = [...(childEdges.get(id)?.keys() ?? [])]
            .filter((child) => included.has(child))
            .map((child) => sortEntry({ id: child, edgeOrder: childEdges.get(id)?.get(child) ?? Number.POSITIVE_INFINITY }))
            .sort((left, right) => compareOrder({ left, right }))
            .map((entry) => entry.id);
        byId.set(id, { id, parent: parents[0] ?? null, parents, children, primaryChildren: [], depth: -1, order: byId.size, shared: parents.length > 1, cycle: false });
    }

    /** @type {Map<string, string[]>} */
    const primaryChildren = new Map();
    for (const entry of byId.values()) {
        if (!entry.parent) continue;
        const children = primaryChildren.get(entry.parent) ?? [];
        children.push(entry.id);
        primaryChildren.set(entry.parent, children);
    }
    for (const entry of byId.values()) entry.primaryChildren = primaryChildren.get(entry.id) ?? [];

    /** @type {string[]} */
    const roots = ordered.filter((id) => included.has(id) && (byId.get(id)?.parents.length ?? 0) === 0);
    /** @param {string[]} seeds */
    const assignDepths = (seeds) => {
        const queue = [];
        for (const id of seeds) {
            const entry = byId.get(id);
            if (!entry || entry.depth >= 0) continue;
            entry.depth = 0;
            queue.push(id);
        }
        for (let cursor = 0; cursor < queue.length; cursor++) {
            const entry = byId.get(queue[cursor]);
            if (!entry) continue;
            for (const child of entry.primaryChildren) {
                const next = byId.get(child);
                if (!next || next.depth >= 0) continue;
                next.depth = entry.depth + 1;
                queue.push(child);
            }
        }
    };
    assignDepths(roots);
    /** @type {string[]} */
    const projectedRoots = [];
    for (const id of ordered) {
        if (!included.has(id) || (byId.get(id)?.depth ?? -1) >= 0) continue;
        const entry = byId.get(id);
        if (entry) entry.parent = null;
        projectedRoots.push(id);
        assignDepths([id]);
    }
    roots.push(...projectedRoots);

    const cycles = cyclesOf({ byId, ordered: ordered.filter((id) => included.has(id)) });
    for (const cycle of cycles) for (const id of cycle) {
        const entry = byId.get(id);
        if (entry) entry.cycle = true;
    }
    const description = graph?.hierarchy;
    return {
        rel: relation,
        nodes: [...byId.values()],
        byId,
        roots,
        ordered: ordered.filter((id) => included.has(id)),
        cycles,
        missing,
        truncated,
        maxNodes: cap,
        ...(Array.isArray(description?.levels) ? { levels: [...description.levels] } : {}),
        ...(description?.levelKinds ? { levelKinds: { ...description.levelKinds } } : {})
    };
}

/**
 * Finds cyclic strongly connected components with iterative Kosaraju passes, so
 * arbitrary depth cannot exhaust the JavaScript call stack and every node in a
 * cycle is marked. Multi-node components are listed once; self-loops are also
 * listed explicitly.
 * @param {{byId: Map<string, HierarchyEntry>, ordered: string[]}} arg0
 * @returns {string[][]}
 */
function cyclesOf({ byId, ordered }) {
    const rank = new Map(ordered.map((id, index) => [id, index]));
    const seen = new Set();
    /** @type {string[]} */
    const finished = [];
    for (const start of ordered) {
        if (seen.has(start)) continue;
        seen.add(start);
        /** @type {Array<{id: string, next: number}>} */
        const stack = [{ id: start, next: 0 }];
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            if (!frame) break;
            const children = byId.get(frame.id)?.children ?? [];
            if (frame.next >= children.length) {
                finished.push(frame.id);
                stack.pop();
                continue;
            }
            const child = children[frame.next++];
            if (!child) continue;
            if (seen.has(child)) continue;
            seen.add(child);
            stack.push({ id: child, next: 0 });
        }
    }

    const assigned = new Set();
    /** @type {string[][]} */
    const cycles = [];
    for (let index = finished.length - 1; index >= 0; index--) {
        const start = finished[index];
        if (!start || assigned.has(start)) continue;
        const component = [];
        const stack = [start];
        assigned.add(start);
        while (stack.length > 0) {
            const id = stack.pop();
            if (!id) continue;
            component.push(id);
            for (const parent of byId.get(id)?.parents ?? []) {
                if (assigned.has(parent)) continue;
                assigned.add(parent);
                stack.push(parent);
            }
        }
        component.sort((left, right) => (rank.get(left) ?? 0) - (rank.get(right) ?? 0) || compareText({ left, right }));
        if (component.length > 1) cycles.push(component);
        for (const id of component) {
            if (byId.get(id)?.children.includes(id)) cycles.push([id, id]);
        }
    }
    return cycles;
}

/**
 * The root-to-node path, using the deterministic primary parent. A cyclic path
 * stops at its first repeated id rather than hanging.
 * @param {{graph?: import('./model.mjs').KnowledgeGraph|null, id?: string, tree?: HierarchyTree|null}} arg0
 * @returns {import('./model.mjs').KnowledgeNode[]}
 */
export function hierarchyPath({ graph = null, id = '', tree = null }) {
    const hierarchy = tree ?? hierarchyOf({ graph, maxNodes: Number.MAX_SAFE_INTEGER });
    const byId = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));
    /** @type {string[]} */
    const path = [];
    const seen = new Set();
    let current = id;
    while (current && !seen.has(current)) {
        seen.add(current);
        path.push(current);
        current = hierarchy.byId.get(current)?.parent ?? '';
    }
    return path.reverse().flatMap((nodeId) => {
        const node = byId.get(nodeId);
        return node ? [node] : [];
    });
}

