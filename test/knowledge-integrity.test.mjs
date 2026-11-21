// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError } from '../lib/core/errors.mjs';
import { KnowledgeComponent } from '../lib/agentic/knowledge/index.mjs';
import { adoptOntology, applyPatch, buildGraph, graphSha, loadGraph, profileSources, proposeOntology, saveGraph, syncCorpus, validateGraph } from '../lib/agentic/knowledge/index.mjs';

const DOC = `# Mutual NDA

This Mutual Non-Disclosure Agreement is between Alpha Ltd and Beta GmbH.

## 1. Definitions

"Confidential Information" means non-public information disclosed by the Discloser.

## 2. Obligations

The Recipient shall keep the Confidential Information secret.
`;

/** @returns {any} */
function demoGraph() {
    return buildGraph({ sources: [{ id: 'S1', name: 'demo.md', text: DOC }] });
}

/** @returns {string} */
function tmp() {
    return mkdtempSync(join(tmpdir(), 'knowledge-integrity-'));
}

// ─── G3-1: a rebuild keeps the authored edges ────────────────────────────────

test('a corpus rebuild keeps an authored edge between two agent nodes', async () => {
    const dir = tmp();
    try {
        const file = join(dir, 'doc.md');
        const store = join(dir, '.knowledge');
        writeFileSync(file, DOC);
        const first = await syncCorpus({ dir: store, paths: [file] });

        const paragraphs = /** @type {Array<any>} */ (first.graph.nodes.filter((/** @type {any} */ node) => node.kind === 'paragraph'));
        assert.ok(paragraphs.length >= 2, 'the corpus must yield two anchored paragraphs');
        const [alpha, beta] = paragraphs;

        applyPatch({ graph: first.graph, patch: {
            nodes: [
                { id: 'issue-1', kind: 'issue', label: 'delivery is owed', derivedFrom: [alpha.id] },
                { id: 'note-1', kind: 'note', label: 'a free agent note' }
            ],
            edges: [
                { from: 'issue-1', to: alpha.id, rel: 'interprets', note: 'the issue reads this clause' },
                { from: alpha.id, to: beta.id, rel: 'conflicts_with', note: 'the clauses pull apart' },
                { from: 'note-1', to: 'issue-1', rel: 'x-flags', note: 'the note flags the issue' }
            ]
        } });
        await saveGraph({ dir: store, graph: first.graph });

        // One line inserted at the top shifts every id below it; nothing the
        // three edges depend on changed.
        writeFileSync(file, `An inserted opening paragraph.\n\n${DOC}`);
        const second = await syncCorpus({ dir: store, paths: [file] });

        assert.equal(second.reused, false);
        assert.deepEqual(second.delta.changed, [file]);
        const kept = /** @type {Array<any>} */ (second.graph.edges.filter((/** @type {any} */ edge) => ['interprets', 'conflicts_with', 'x-flags'].includes(edge.rel)));
        assert.deepEqual(kept.map((edge) => edge.rel).sort(), ['conflicts_with', 'interprets', 'x-flags']);
        const ids = new Set(second.graph.nodes.map((/** @type {any} */ node) => node.id));
        for (const edge of kept) {
            assert.ok(ids.has(edge.from), `${edge.rel} lost its from endpoint`);
            assert.ok(ids.has(edge.to), `${edge.rel} lost its to endpoint`);
        }
        assert.ok(ids.has('issue-1') && ids.has('note-1'), 'the agent nodes survive too');
        assert.equal(second.derived.droppedEdges, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ─── G3-2: the gate threshold is a threshold ────────────────────────────────

test('an escalated yes does not admit an edge', async () => {
    const dir = tmp();
    try {
        const events = new EventEmitter();
        /** @type {Array<any>} */
        const rejected = [];
        events.on('knowledge:edge_rejected', (/** @type {any} */ envelope) => rejected.push(envelope));
        const gate = { gate: async () => ({ verdict: true, certainty: 0.6, escalated: true }) };
        const component = new KnowledgeComponent({ dir, graph: demoGraph(), gate, eventEmitter: events });
        await component.save({ args: {
            nodes: [{ id: 'I1', kind: 'issue', label: 'scope', derivedFrom: ['S1-doc'] }],
            edges: [{ from: 'I1', to: 'S1-doc', rel: 'interprets', note: 'reading' }]
        } });

        assert.equal(rejected.length, 1, 'the gate was consulted exactly once');
        assert.equal(rejected[0].reason, 'below threshold');
        const saved = /** @type {any} */ (await loadGraph({ dir }));
        assert.ok(!saved.graph.edges.some((/** @type {any} */ edge) => edge.rel === 'interprets'), 'an escalated yes must not admit an edge');

        const sure = new KnowledgeComponent({ dir: tmp(), graph: demoGraph(), gate: { gate: async () => ({ verdict: true, certainty: 0.95, escalated: false }) } });
        await sure.save({ args: {
            nodes: [{ id: 'I1', kind: 'issue', label: 'scope', derivedFrom: ['S1-doc'] }],
            edges: [{ from: 'I1', to: 'S1-doc', rel: 'interprets', note: 'reading' }]
        } });
        assert.ok((await sure.graph()).edges.some((/** @type {any} */ edge) => edge.rel === 'interprets'), 'a confident yes still admits');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ─── G3-3: a rejected patch changes nothing ─────────────────────────────────

test('a rejected patch leaves the graph byte-identical', () => {
    const graph = demoGraph();
    const target = /** @type {any} */ (graph.nodes.find((/** @type {any} */ node) => node.kind === 'section'));
    const before = JSON.stringify(graph);
    const beforeSha = graphSha({ graph });

    assert.throws(
        () => applyPatch({ graph, patch: {
            updateNodes: [{ id: target.id, label: 'RELABELLED BY FAILED PATCH', tags: ['poison'] }],
            edges: [{ from: 'S1-doc', to: 'GHOST', rel: 'supports', note: 'dangling' }]
        } }),
        /dangling/
    );

    assert.equal(JSON.stringify(graph), before, 'the graph must be byte-identical after a rejection');
    assert.equal(graphSha({ graph }), beforeSha);
    assert.ok(!target.tags?.includes('poison'));
});

// ─── G3-4: the patch refuses what the validator refuses ─────────────────────

test('a patch validateGraph would reject is refused by applyPatch', () => {
    const graph = demoGraph();

    assert.throws(
        () => applyPatch({ graph, patch: { nodes: [{ id: 'B1', kind: 'issue', label: 'x', derived: /** @type {any} */ ('yes') }] } }),
        /not a boolean/
    );
    assert.ok(!graph.nodes.some((/** @type {any} */ node) => node.id === 'B1'), 'a refused node is not added');

    assert.throws(
        () => applyPatch({ graph, patch: { nodes: [{ id: 'B2', kind: 'issue', label: 'x', source: /** @type {any} */ ({ sourceId: 7 }) }] } }),
        /no sourceId/
    );

    // The same two shapes are what validateGraph refuses.
    const bad = demoGraph();
    bad.nodes.push({ id: 'B1', kind: 'issue', label: 'x', derived: /** @type {any} */ ('yes') });
    assert.equal(validateGraph({ graph: bad }).status, 'fail');
    assert.ok(validateGraph({ graph: bad }).findings.some((finding) => finding.code === 'node-derived'));
});

test('save refuses a graph the validator would reject, before it is written', async () => {
    const dir = tmp();
    try {
        const graph = demoGraph();
        graph.nodes.push({ id: 'BAD', kind: 'issue', label: 'bad', derived: /** @type {any} */ ('yes') });
        const component = new KnowledgeComponent({ dir, graph });

        await assert.rejects(
            () => component.save({ args: { nodes: [{ id: 'I1', kind: 'issue', label: 'ok', derivedFrom: ['S1-doc'] }] } }),
            ConfigurationError
        );
        const onDisk = await loadGraph({ dir });
        assert.equal(onDisk.status, 'missing', 'a refused save writes nothing');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a refused save leaves the live graph untouched', async () => {
    const dir = tmp();
    try {
        const graph = demoGraph();
        graph.nodes.push({ id: 'BAD', kind: 'issue', label: 'bad', derived: /** @type {any} */ ('yes') });
        const component = new KnowledgeComponent({ dir, graph });
        const before = graphSha({ graph: await component.graph() });

        await assert.rejects(
            () => component.save({ args: { nodes: [{ id: 'I9', kind: 'issue', label: 'refused', derivedFrom: ['S1-doc'] }] } }),
            ConfigurationError
        );
        const live = await component.graph();
        assert.ok(!live.nodes.some((/** @type {any} */ node) => node.id === 'I9'), 'a refused node must not leak into the live graph');
        assert.equal(graphSha({ graph: live }), before, 'a refusal must leave graph() byte-identical');

        // The next legitimate save starts from the graph the refusal left behind.
        await component.save({ args: {
            removeNodes: ['BAD'],
            nodes: [{ id: 'GOOD', kind: 'issue', label: 'kept', derivedFrom: ['S1-doc'] }]
        } });
        const onDisk = /** @type {any} */ (await loadGraph({ dir }));
        assert.ok(onDisk.graph.nodes.some((/** @type {any} */ node) => node.id === 'GOOD'));
        assert.ok(!onDisk.graph.nodes.some((/** @type {any} */ node) => node.id === 'I9'), 'the refused node must never reach the store');
        assert.ok(!onDisk.graph.nodes.some((/** @type {any} */ node) => node.id === 'BAD'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ─── G3-4: a bad stored node does not take the good ones with it ───────────

test('a bad agent node does not destroy the good ones at the next sync', async () => {
    const dir = tmp();
    try {
        const file = join(dir, 'doc.md');
        const store = join(dir, '.knowledge');
        writeFileSync(file, DOC);
        const first = await syncCorpus({ dir: store, paths: [file] });

        const paragraph = /** @type {any} */ (first.graph.nodes.find((/** @type {any} */ node) => node.kind === 'paragraph'));
        applyPatch({ graph: first.graph, patch: {
            nodes: [{ id: 'good-1', kind: 'issue', label: 'anchored reading', derivedFrom: [paragraph.id] }]
        } });
        // A stored graph written by an older build: the validator refuses this
        // node, and the whole graph used to be thrown away with it.
        first.graph.nodes.push({ id: 'bad-1', kind: 'issue', label: 'bad', derived: /** @type {any} */ ('yes'), derivedFrom: [paragraph.id] });
        first.graph.edges.push({ id: 'BAD-E', from: 'bad-1', to: 'GHOST', rel: 'supports', note: 'dangling' });
        await saveGraph({ dir: store, graph: first.graph });

        const second = await syncCorpus({ dir: store, paths: [file] });
        assert.equal(second.repaired, true);
        assert.ok(second.graph.nodes.some((/** @type {any} */ node) => node.id === 'good-1'), 'the good agent node must survive');
        assert.ok(!second.graph.nodes.some((/** @type {any} */ node) => node.id === 'bad-1'), 'the bad node is not trusted');
        assert.equal(second.derived.kept, 1);
        assert.equal(second.derived.dropped, 1);
        assert.equal(second.derived.droppedEdges, 1, 'the dangling edge is dropped and counted');
        assert.notEqual(second.validation.status, 'fail', JSON.stringify(second.validation.findings));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ─── G3-5: every non-structural patch edge goes through the gate ────────────

/** A gate that always refuses and records each call. @returns {{calls: Array<any>, gate: {gate: (arg0: any) => Promise<{verdict: boolean, reason: string}>}}} */
function alwaysNoGate() {
    /** @type {Array<any>} */
    const calls = [];
    return { calls, gate: { gate: async (/** @type {any} */ arg) => { calls.push(arg); return { verdict: false, reason: 'not supported' }; } } };
}

/** A profile that declares `overrides` as a promoted relation. @returns {any} */
function overridesProfile() {
    return { name: 'overrides', kinds: ['issue', 'note'], relations: ['overrides'] };
}

/** A two-node patch carrying one edge of the given relation. @param {string} rel @returns {any} */
function edgePatch(rel) {
    return {
        nodes: [
            { id: 'A', kind: 'issue', label: 'rule A', derivedFrom: ['S1'] },
            { id: 'B', kind: 'issue', label: 'rule B', derivedFrom: ['S1'] }
        ],
        edges: [{ from: 'A', to: 'B', rel, note: 'A displaces B' }]
    };
}

test('a profile-declared relation is gated like its x- form', async () => {
    const dir = tmp();
    try {
        const { calls, gate } = alwaysNoGate();
        const component = new KnowledgeComponent({ dir, profile: overridesProfile(), gate });
        await component.save({ args: edgePatch('overrides') });

        const saved = /** @type {any} */ (await loadGraph({ dir }));
        const consulted = calls.length === 1;
        const admitted = saved.graph.edges.some((/** @type {any} */ edge) => edge.rel === 'overrides');
        assert.equal(consulted, true, 'a declared non-structural relation must reach the gate');
        assert.equal(admitted, false, 'the gate said no, so the edge must not be admitted');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a promoted relation does not become free', async () => {
    const dir = tmp();
    try {
        const proposal = proposeOntology({ profile: profileSources({ sources: [{ id: 'S1', name: 'demo.md', text: DOC }] }) });
        proposal.profile = { ...proposal.profile, relations: [...proposal.profile.relations, 'overrides'] };
        await adoptOntology({ dir, proposal });

        const { calls, gate } = alwaysNoGate();
        const component = new KnowledgeComponent({ dir, ontology: 'adopted', gate });
        await component.save({ args: edgePatch('overrides') });

        const saved = /** @type {any} */ (await loadGraph({ dir }));
        const consulted = calls.length === 1;
        const admitted = saved.graph.edges.some((/** @type {any} */ edge) => edge.rel === 'overrides');
        assert.equal(consulted, true, 'promotion into ontology.json must not skip the gate');
        assert.equal(admitted, false, 'a promoted relation the gate refuses must not be admitted');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a structural relation stays ungated', async () => {
    const dir = tmp();
    try {
        const { calls, gate } = alwaysNoGate();
        const component = new KnowledgeComponent({ dir, gate });
        await component.save({ args: edgePatch('contains') });

        const saved = /** @type {any} */ (await loadGraph({ dir }));
        assert.equal(calls.length, 0, 'a parse-proved structural edge must not cost a gate call');
        assert.ok(saved.graph.edges.some((/** @type {any} */ edge) => edge.rel === 'contains'), 'a structural edge is admitted without the gate');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a refused relation emits one knowledge:edge_rejected', async () => {
    const dir = tmp();
    try {
        const events = new EventEmitter();
        /** @type {Array<any>} */
        const rejected = [];
        events.on('knowledge:edge_rejected', (/** @type {any} */ envelope) => rejected.push(envelope));
        const gate = { gate: async () => ({ verdict: false, reason: 'not supported' }) };
        const component = new KnowledgeComponent({ dir, profile: overridesProfile(), gate, eventEmitter: events });
        await component.save({ args: edgePatch('overrides') });

        assert.equal(rejected.length, 1, 'a refused non-structural relation is reported once');
        assert.equal(rejected[0].rel, 'overrides');
        assert.equal(rejected[0].reason, 'not supported', 'the verdict reason is carried into the event');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
