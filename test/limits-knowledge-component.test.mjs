// @ts-check
/**
 * @file G1: the knowledge component and renderer read their limits through the
 * resolver.
 * @version 0.12.0
 *
 * @description
 * `docs/LIMITS.md` promises every declared limit is overridable. The knowledge
 * module used to read `LIMIT_REGISTRY.<key>.default` — a second copy of the
 * number — so `MERCI_LIMIT_*`, the limits file, `setLimits()` and the kill
 * switch never reached the renderer, the patcher or the validator.
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
import { applyPatch, emptyGraph, renderKnowledgeBlock } from '../lib/agentic/knowledge/index.mjs';

const ENV_KEYS = [
    LIMITS_SWITCH_ENV,
    LIMITS_DISABLED_ENV,
    LIMITS_FILE_ENV,
    LIMITS_GUARD_ENV,
    ...Object.values(LIMIT_REGISTRY).map((entry) => entry.env),
    ...Object.values(LIMIT_REGISTRY).flatMap((entry) => [...entry.legacyEnv])
];

/**
 * A graph of `count` section nodes; `text` sets each node's text, which is what
 * the render tiers size on.
 * @param {{count: number, text?: string}} arg0 -
 * @returns {import('../lib/agentic/knowledge/model.mjs').KnowledgeGraph}
 */
function sections({ count, text = '' }) {
    const graph = emptyGraph();
    for (let index = 0; index < count; index++) {
        graph.nodes.push({
            id: `S1-s-${index}`,
            kind: 'section',
            label: `Section ${index} title`,
            text,
            salience: 'scope',
            derived: true,
            derivedFrom: ['x']
        });
    }
    return graph;
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
    setLimitWarningHandler({ handler: (/** @type {string} */ message) => { console.warn(message); } });
});

test('G1 an override of knowledge_query_budget_chars shrinks the rendered block', () => {
    const graph = sections({ count: 15 });
    const full = /** @type {string} */ (renderKnowledgeBlock({ graph, result: null }));
    assert.ok(full.length > 650 && full.length < 780, `fixture drifted: default block is ${full.length} chars`);
    setLimits({ values: { knowledge_query_budget_chars: 200 } });
    const tight = /** @type {string} */ (renderKnowledgeBlock({ graph, result: null }));
    assert.ok(tight.length <= full.length - 150, `the render budget must be the resolved limit; got ${tight.length} with the override and ${full.length} without`);
});

test('G1 an override of knowledge_split_chars switches the render path', () => {
    // 12 sections × 20 chars = 240 chars of node text, below the 90k default.
    const graph = sections({ count: 12, text: 'x'.repeat(20) });
    setLimits({ values: { knowledge_split_chars: 100 } });
    const block = /** @type {string} */ (renderKnowledgeBlock({ graph, result: null }));
    assert.match(block, /This graph is large\. Query it by id; do not request the whole graph\./);
});

test('G1 an override of knowledge_patch_max_nodes is enforced', () => {
    setLimits({ values: { knowledge_patch_max_nodes: 1 } });
    const graph = emptyGraph();
    assert.throws(
        () => applyPatch({ graph, patch: { nodes: [
            { id: 'P1', kind: 'statement', label: 'one', derived: true, derivedFrom: ['x'] },
            { id: 'P2', kind: 'statement', label: 'two', derived: true, derivedFrom: ['x'] }
        ] } }),
        /at most 1 nodes/
    );
});
