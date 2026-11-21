// @ts-check
/**
 * @file W1-N1: the knowledge query reads its limits through the resolver.
 * @version 0.12.0
 *
 * @description
 * `docs/LIMITS.md` promises every declared limit is overridable. A default
 * parameter or a clamp that reads `LIMIT_REGISTRY.<key>.default` is a second
 * copy of the number, so an env/file/`setLimits` override never lands.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LIMIT_REGISTRY } from '../lib/core/constants/limits.mjs';
import {
    resetLimits,
    reloadLimits,
    setLimits,
    setLimitWarningHandler,
    LIMITS_SWITCH_ENV,
    LIMITS_DISABLED_ENV,
    LIMITS_FILE_ENV,
    LIMITS_GUARD_ENV
} from '../lib/core/limit-config.mjs';
import { expandSubgraph, queryGraph, rankNodes } from '../lib/agentic/knowledge/query.mjs';

const ENV_KEYS = [
    LIMITS_SWITCH_ENV,
    LIMITS_DISABLED_ENV,
    LIMITS_FILE_ENV,
    LIMITS_GUARD_ENV,
    ...Object.values(LIMIT_REGISTRY).map((entry) => entry.env),
    ...Object.values(LIMIT_REGISTRY).flatMap((entry) => [...entry.legacyEnv])
];

/**
 * A five-node chain n0 → n1 → n2 → n3 → n4.
 * @returns {import('../lib/agentic/knowledge/model.mjs').KnowledgeGraph}
 */
function chain() {
    return {
        sources: [],
        nodes: [0, 1, 2, 3, 4].map((i) => ({ id: `n${i}`, label: `n${i}`, kind: 'note', tier: 'F' })),
        edges: [0, 1, 2, 3].map((i) => ({ id: `e${i}`, from: `n${i}`, to: `n${i + 1}`, rel: 'references' }))
    };
}

test.beforeEach(() => {
    resetLimits();
    for (const key of ENV_KEYS) delete process.env[key];
    reloadLimits();
    setLimitWarningHandler({ handler: () => {} });
});

test.afterEach(() => {
    resetLimits();
    for (const key of ENV_KEYS) delete process.env[key];
    reloadLimits();
    setLimitWarningHandler({ handler: (message) => { console.warn(message); } });
});

test('W1-N1 an override of knowledge_query_max_depth reaches queryGraph', () => {
    setLimits({ values: { knowledge_query_max_depth: 1 } });
    const found = queryGraph({ graph: chain(), id: 'n0', depth: 4 });
    assert.deepEqual(found.nodes.map((node) => node.id).sort(), ['n0', 'n1'], 'the clamp is the resolved limit, not the code default');
});

test('W1-N1 an override of knowledge_query_default_depth reaches expandSubgraph', () => {
    setLimits({ values: { knowledge_query_default_depth: 1 } });
    const reached = expandSubgraph({ graph: chain(), seeds: ['n0'] });
    assert.deepEqual([...reached].sort(), ['n0', 'n1'], 'the default depth is resolved per call');
});

test('W1-N1 an override of knowledge_query_max_nodes reaches rankNodes', () => {
    setLimits({ values: { knowledge_query_max_nodes: 1 } });
    const graph = chain();
    const ranked = rankNodes({ graph, candidates: graph.nodes, similarity: new Map([['n4', 1]]) });
    assert.equal(ranked.length, 1, 'the ranking cap is the resolved limit');
    assert.equal(ranked[0].node.id, 'n4', 'the highest-scoring candidate still wins');
});
