// @ts-check

/**
 * Wave 7 / PL1a + PL1b — one Plan, two views.
 *
 * A plan is a DAG of intents. The DAG executor reads it through `toDag()`; the
 * StateMachine reads it through `toStateMachine()`. Both projections report what
 * they could not carry (join, sequence, condition, cycle, entry, execute nodes), so
 * a lossy conversion is inspectable instead of implied.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Plan, PLAN_VERSION } from '../lib/agentic/planning/plan.mjs';
import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';

/** @param {{id: string, title?: string, dependencies?: string[], userPromptTemplate?: string, [k: string]: any}} step */
const dagStep = (step) => ({
    title: step.title ?? step.id,
    systemPrompt: `Do ${step.id}.`,
    userPromptTemplate: step.userPromptTemplate ?? `${step.id.toUpperCase()}-PROMPT`,
    ...step,
});

// ─── PL1a: the DAG projection is faithful ──────────────────────────────────

test('PL/dag-roundtrip: fromDag().toDag() returns the same steps', () => {
    const steps = [
        dagStep({ id: 'a' }),
        dagStep({ id: 'b', dependencies: ['a'] }),
        dagStep({ id: 'c', dependencies: ['a'] }),
        dagStep({ id: 'd', dependencies: ['b', 'c'] }),
    ];
    const plan = Plan.fromDag({ steps, objective: 'ship it' });
    assert.equal(plan.version, PLAN_VERSION);
    assert.equal(plan.objective, 'ship it');
    assert.deepEqual(plan.nodes.map((n) => n.id), ['a', 'b', 'c', 'd']);
    assert.deepEqual(plan.nodes[3]?.dependsOn, ['b', 'c']);
    const { steps: back, lossy } = plan.toDag();
    assert.deepEqual(back, steps, 'every step field survives verbatim');
    assert.deepEqual(lossy, [], 'a DAG to a DAG loses nothing');
});

test('PL/brief: a node brief prefers an explicit title, then the description, then the prompt', () => {
    const plan = Plan.fromDag({ steps: [
        { id: 'a', title: 'Collect specs' },
        { id: 'b', description: 'Draft the summary' },
        { id: 'c', userPromptTemplate: '\n  Compare the drafts\n and pick one.' },
        { id: 'd' },
    ] });
    assert.deepEqual(plan.nodes.map((n) => n.brief), [
        'Collect specs',
        'Draft the summary',
        'Compare the drafts',
        'd',
    ]);
});

test('PL/expansion: a static sub-plan is recorded, not flattened', () => {
    const plan = Plan.fromDag({ steps: [dagStep({ id: 'a', subSteps: [dagStep({ id: 'a1' })] })] });
    assert.equal(plan.nodes[0]?.expansion, 'static');
});

// ─── PL1a: validation is fail-closed ───────────────────────────────────────

test('PL/validate: an empty plan, duplicate ids, unknown deps, self-deps and cycles are rejected', () => {
    const empty = () => new Plan({ nodes: [] }).validate();
    assert.throws(empty, /no nodes/);

    assert.throws(() => Plan.fromDag({ steps: [dagStep({ id: 'a' }), dagStep({ id: 'a' })] }), /duplicate node ids: a/);
    assert.throws(() => Plan.fromDag({ steps: [dagStep({ id: 'a', dependencies: ['ghost'] })] }), /unknown node 'ghost'/);
    assert.throws(() => Plan.fromDag({ steps: [dagStep({ id: 'a', dependencies: ['a'] })] }), /depends on itself/);
    assert.throws(() => Plan.fromDag({ steps: [
        dagStep({ id: 'a', dependencies: ['b'] }),
        dagStep({ id: 'b', dependencies: ['a'] }),
    ] }), /not a DAG/);
});

// ─── PL1a: JSON round-trip ─────────────────────────────────────────────────

test('PL/json: a plan round-trips through JSON (functions do not, like a checkpoint)', () => {
    const steps = [dagStep({ id: 'a' }), dagStep({ id: 'b', dependencies: ['a'], verify: () => ({ passed: true }) })];
    const plan = Plan.fromDag({ steps, objective: 'o' });
    const restored = Plan.fromJSON(plan.toJSON());
    assert.deepEqual(restored.nodes.map((n) => [n.id, n.dependsOn, n.brief]), plan.nodes.map((n) => [n.id, n.dependsOn, n.brief]));
    assert.equal(restored.objective, 'o');
    const viaString = Plan.fromJSON(JSON.stringify(plan));
    assert.equal(viaString.nodes.length, 2);
    assert.equal(typeof /** @type {Record<string, unknown>|undefined} */ (viaString.nodes[1]?.step)?.verify, 'undefined', 'a function cannot travel in JSON');
});

// ─── PL1b: the StateMachine projection ─────────────────────────────────────

test('PL/dag-to-sm: the graph is a topological chain the StateMachine accepts', () => {
    const plan = Plan.fromDag({ steps: [
        dagStep({ id: 'a' }),
        dagStep({ id: 'b', dependencies: ['a'] }),
        dagStep({ id: 'c', dependencies: ['a'] }),
        dagStep({ id: 'd', dependencies: ['b', 'c'] }),
    ] });
    const { graph, lossy } = plan.toStateMachine();
    assert.equal(graph.entry, 'a');
    assert.deepEqual(graph.edges.map((e) => `${e.from}>${e.to}`), ['a>b', 'b>c', 'c>d'], 'a chain in topological order');
    assert.equal(graph.nodes.at(-1)?.terminal, true);
    const kinds = lossy.map((l) => l.kind).filter((k) => k === 'join');
    assert.deepEqual(kinds, ['join'], 'the multi-dependency node reports the missing join');
    assert.ok(lossy.some((l) => l.kind === 'sequence'), 'parallelism is reported as lost');
    // The machine accepts the projection (validateGraph runs in the constructor).
    const machine = new StateMachine({ graph, options: { client: /** @type {any} */ ({}) } });
    assert.equal(machine.current, 'a');
});

test('PL/sm-to-dag: ordering survives, conditions/cycles/execute nodes are reported', () => {
    const graph = {
        entry: 'start',
        nodes: [
            { id: 'start', systemPrompt: 'Begin.', userPromptTemplate: 'start' },
            { id: 'work', systemPrompt: 'Work.', userPromptTemplate: 'work' },
            { id: 'check', systemPrompt: 'Check.', userPromptTemplate: 'check' },
            { id: 'js', title: 'A JS node', execute: () => 'x' },
        ],
        edges: [
            { from: 'start', to: 'work', condition: null },
            { from: 'work', to: 'check', condition: 'ctx.score > 0.5' },
            { from: 'check', to: 'work', condition: 'ctx.retry === true' }, // cycle
            { from: 'check', to: 'js', condition: null },
        ],
    };
    const plan = Plan.fromStateMachine({ graph, objective: 'o' });
    const losses = /** @type {any[]} */ (plan.meta.lossy);
    const kinds = new Set(losses.map((l) => l.kind));
    assert.ok(kinds.has('condition'), 'the branch predicate is reported');
    assert.ok(kinds.has('cycle'), 'the back edge is reported');
    assert.ok(kinds.has('node-execute'), 'a JS execute node is reported');
    assert.equal(/** @type {Record<string, unknown>|undefined} */ (plan.nodes.find((n) => n.id === 'js')?.step)?.execute, undefined, 'the function is not carried in step');

    // The ordering survives as dependencies, and the plan is a valid DAG.
    assert.deepEqual(plan.nodes.find((n) => n.id === 'work')?.dependsOn, ['start']);
    assert.deepEqual(plan.nodes.find((n) => n.id === 'check')?.dependsOn, ['work']);
    assert.deepEqual(plan.nodes.find((n) => n.id === 'js')?.dependsOn, ['check']);
    assert.equal(plan.node({ id: 'work' })?.dependsOn.includes('check'), false, 'the cycle was cut, not kept');
    plan.validate();
});

test('PL/sm-to-dag: a cycle can be refused instead of cut', () => {
    const graph = {
        entry: 'a',
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    };
    assert.throws(() => Plan.fromStateMachine({ graph, lossyCycles: false }), /cannot express the cycle/);
});

test('PL/sm-to-dag: several roots and a terminal node are reported', () => {
    const graph = {
        entry: 'a',
        nodes: [{ id: 'a', terminal: true }, { id: 'b', maxVisits: 3 }],
        edges: [],
    };
    const plan = Plan.fromStateMachine({ graph });
    const kinds = /** @type {any[]} */ (plan.meta.lossy).map((l) => l.kind);
    assert.ok(kinds.includes('early-terminal'));
    assert.ok(kinds.includes('reentry'));
    assert.ok(kinds.includes('entry'), 'two roots mean the machine and the plan disagree on where to start');
});

test('PL/roundtrip-sm: a plan projected to a machine and back keeps the order', () => {
    const plan = Plan.fromDag({ steps: [dagStep({ id: 'a' }), dagStep({ id: 'b', dependencies: ['a'] })] });
    const { graph } = plan.toStateMachine();
    const back = Plan.fromStateMachine({ graph });
    assert.deepEqual(back.nodes.map((n) => n.id).sort(), ['a', 'b']);
    assert.deepEqual(back.nodes.find((n) => n.id === 'b')?.dependsOn, ['a']);
});

// ─── verifier round: the losses the first pass missed ──────────────────────

test('PL/template-dialects: the unambiguous refs are translated, the rest are reported', () => {
    const dag = Plan.fromDag({ steps: [
        dagStep({ id: 'a' }),
        dagStep({ id: 'b', dependencies: ['a'], userPromptTemplate: 'Use {{a.output}} and {{a.output.rows.length}}.' }),
    ] });
    const { graph, lossy } = dag.toStateMachine();
    const b = graph.nodes.find((n) => n.id === 'b');
    assert.equal(b?.userPromptTemplate, 'Use {{context.a}} and {{context.a.rows.length}}.', 'the DAG dialect becomes the machine dialect');
    assert.equal(lossy.some((l) => l.kind === 'template-dialect'), false, 'a translatable ref is not a loss');

    const sm = Plan.fromStateMachine({ graph: {
        entry: 'a',
        nodes: [
            { id: 'a', userPromptTemplate: 'start' },
            { id: 'b', userPromptTemplate: 'Use {{context.a}} and {{context.globalScore}} and {{a.summary}}.' },
        ],
        edges: [{ from: 'a', to: 'b' }],
    } });
    const step = /** @type {Record<string, unknown>|undefined} */ (sm.nodes.find((n) => n.id === 'b')?.step);
    assert.equal(step?.userPromptTemplate, 'Use {{a.output}} and {{context.globalScore}} and {{a.summary}}.', 'only the known-node ref is translated');
    const kinds = /** @type {any[]} */ (sm.meta.lossy).map((l) => l.kind);
    assert.ok(kinds.includes('shared-context'), 'a machine variable has no DAG equivalent');
    assert.ok(kinds.includes('template-dialect'), 'a non-output ref is reported, not guessed');
});

test('PL/entry-and-fan-out: an unreachable node, a fan-out and an unsatisfiable entry are reported', () => {
    const sm = Plan.fromStateMachine({ graph: {
        entry: 'start',
        nodes: [{ id: 'start' }, { id: 'orphan' }, { id: 'left' }, { id: 'right' }],
        edges: [
            { from: 'start', to: 'left' },
            { from: 'start', to: 'right' },
            { from: 'orphan', to: 'left' },
        ],
    } });
    const losses = /** @type {any[]} */ (sm.meta.lossy);
    const kinds = losses.map((l) => l.kind);
    assert.ok(kinds.includes('unreachable'), 'orphan is unreachable from the entry');
    assert.ok(kinds.includes('fan-out'), 'the machine takes one branch; the DAG would run both');
    assert.equal(sm.nodes.find((n) => n.id === 'left')?.dependsOn.includes('orphan'), false, 'an unreachable prerequisite is not carried');
});

test('PL/timeout: the two engines name the step deadline differently, and the difference is reported', () => {
    const sm = Plan.fromStateMachine({ graph: {
        entry: 'a',
        nodes: [{ id: 'a', timeoutMs: 1000 }],
        edges: [],
    } });
    assert.ok(/** @type {any[]} */ (sm.meta.lossy).some((l) => l.kind === 'timeout'));

    const dag = Plan.fromDag({ steps: [dagStep({ id: 'a', stepTimeoutMs: 500 })] });
    const { lossy } = dag.toStateMachine();
    assert.ok(lossy.some((l) => l.kind === 'timeout'), 'stepTimeoutMs is not the machine timeoutMs');
});

test('PL/losses-surface: a plan carries its ingestion losses into both projections', () => {
    const sm = Plan.fromStateMachine({ graph: {
        entry: 'a',
        nodes: [{ id: 'a', terminal: true, execute: () => 'x' }, { id: 'b' }],
        edges: [{ from: 'a', to: 'b', condition: 'ctx.ok' }],
    } });
    const dagLosses = sm.toDag().lossy.map((l) => l.kind);
    const smLosses = sm.toStateMachine().lossy.map((l) => l.kind);
    assert.ok(dagLosses.includes('node-execute') && dagLosses.includes('condition'));
    assert.ok(smLosses.includes('node-execute') && smLosses.includes('condition'));
});

test('PL/json-fail-closed: a newer version, a missing node list and a malformed graph are rejected', () => {
    assert.throws(() => Plan.fromJSON({ version: PLAN_VERSION + 1, nodes: [{ id: 'a', brief: 'a', dependsOn: [] }] }), /cannot read plan version/);
    assert.throws(() => Plan.fromJSON({ objective: 'o' }), /requires a nodes array/);
    assert.throws(() => Plan.fromJSON('not json'), /could not parse/);
    assert.throws(() => Plan.fromJSON({ nodes: [{ id: 'a', brief: 'a', dependsOn: ['ghost'] }] }), /unknown node 'ghost'/);
    assert.throws(() => Plan.fromJSON({ nodes: [/** @type {any} */ ({ id: 'a', brief: 'a', dependsOn: 'b' })] }), /non-array dependsOn/);
    assert.throws(() => Plan.fromJSON({ nodes: [] }), /no nodes/);
});

test('PL/json-copy: toJSON returns a copy, so a caller cannot mutate the plan', () => {
    const plan = Plan.fromDag({ steps: [dagStep({ id: 'a' }), dagStep({ id: 'b', dependencies: ['a'] })] });
    const doc = plan.toJSON();
    doc.nodes[0].brief = 'changed';
    doc.nodes[1].dependsOn.push('ghost');
    assert.equal(plan.nodes[0]?.brief, 'a');
    assert.deepEqual(plan.nodes[1]?.dependsOn, ['a']);
});

test('PL/dag-roundtrip-extra: verify survives the round trip, and the order is topological, not alphabetical', () => {
    const verify = () => ({ passed: true });
    const steps = [
        dagStep({ id: 'z' }),
        dagStep({ id: 'y', dependencies: ['z'], verify }),
        dagStep({ id: 'x', dependencies: ['y'] }),
    ];
    const plan = Plan.fromDag({ steps });
    const back = plan.toDag().steps;
    assert.equal(back[1]?.verify, verify, 'the function is carried, not cloned');
    const { graph } = plan.toStateMachine();
    assert.deepEqual(graph.edges.map((e) => `${e.from}>${e.to}`), ['z>y', 'y>x'], 'insertion order is preserved when it is topological');
    assert.equal(graph.entry, 'z');
});

test('PL/to-sm-entry: a non-root entry is refused, and a self-loop is cut', () => {
    const plan = Plan.fromDag({ steps: [dagStep({ id: 'a' }), dagStep({ id: 'b', dependencies: ['a'] })] });
    assert.throws(() => plan.toStateMachine({ entry: 'b' }), /needs an entry that is a root/);

    const sm = Plan.fromStateMachine({ graph: {
        entry: 'a',
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [{ from: 'a', to: 'a' }, { from: 'a', to: 'b' }],
    } });
    const kinds = /** @type {any[]} */ (sm.meta.lossy).map((l) => l.kind);
    assert.ok(kinds.includes('cycle'), 'a self-loop is a cut cycle');
    assert.deepEqual(sm.nodes.find((n) => n.id === 'b')?.dependsOn, ['a']);
});
