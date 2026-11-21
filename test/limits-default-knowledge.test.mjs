// @ts-check
/**
 * @file G1: the knowledge module resolves its limits, it does not copy a default.
 * @version 0.12.0
 *
 * @description
 * A cheap structural guard over the five files G1 owns, plus one behavioural
 * proof that the renderer read is live: `knowledge_wiki_max_section_nodes` is
 * applied per call, so a module-scope constant is no longer in the path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { emptyGraph, renderWiki } from '../lib/agentic/knowledge/index.mjs';

const FILES = [
    'lib/agentic/knowledge/component.mjs',
    'lib/agentic/knowledge/model.mjs',
    'lib/agentic/knowledge/profile.mjs',
    'lib/agentic/knowledge/store.mjs',
    'lib/agentic/knowledge/render.mjs'
];

const ENV_KEYS = [
    LIMITS_SWITCH_ENV,
    LIMITS_DISABLED_ENV,
    LIMITS_FILE_ENV,
    LIMITS_GUARD_ENV,
    ...Object.values(LIMIT_REGISTRY).map((entry) => entry.env),
    ...Object.values(LIMIT_REGISTRY).flatMap((entry) => [...entry.legacyEnv])
];

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

test('G1 the knowledge files read LIMITS, never LIMIT_REGISTRY', () => {
    for (const file of FILES) {
        const source = readFileSync(file, 'utf8');
        assert.ok(!source.includes('LIMIT_REGISTRY'), `${file} still reads the registry default`);
        assert.match(source, /import \{ LIMITS \} from '\.\.\/\.\.\/core\/limit-config\.mjs';/, `${file} must import the resolver`);
    }
});

test('G1 knowledge_wiki_max_section_nodes is resolved per call', () => {
    const graph = emptyGraph();
    for (let index = 0; index < 3; index++) {
        graph.nodes.push({ id: `S1-s-${index}`, kind: 'section', label: `Section ${index}`, text: '', derived: true, derivedFrom: ['x'] });
    }
    setLimits({ values: { knowledge_wiki_max_section_nodes: 1 } });
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-limits-'));
    try {
        renderWiki({ graph, dir });
        const mmd = readFileSync(join(dir, 'wiki', 'graph.mmd'), 'utf8');
        assert.equal(mmd.split('["').length - 1, 1, 'the mermaid view takes the resolved cap, not the code default');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
