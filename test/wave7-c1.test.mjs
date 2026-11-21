// @ts-check

/**
 * Wave 7 / C1 — a step reads only its ANCESTORS' outputs.
 *
 * The finding: the DAG executor's intake (`intakeMode: 'all' | 'some'`) and its
 * template interpolation read the LIVE completed set, so a parallel branch that
 * happened to finish while a step was waiting became an input. A retry could
 * therefore absorb a non-ancestor sibling — the same step, run twice, saw
 * different inputs depending on timing.
 *
 * The contract these checks encode: a step's prompt and intake are a function of
 * its **transitive dependencies** (and the run context), never of what finished
 * concurrently. A reference to a non-ancestor renders `[UNRESOLVED: …]` and
 * warns, so the plan bug is visible instead of silently changing the answer.
 *
 * Written against the pre-fix tree; the leak checks are expected to fail there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

/**
 * A client whose sessions record what each step was asked and answer by marker.
 * @param {{runImpl: (text: string) => Promise<any>}} arg0
 * @returns {any}
 */
function makeClient({ runImpl }) {
    const sessions = /** @type {any[]} */ ([]);
    return {
        sessions,
        session() {
            const s = {
                provider: 'openai',
                withSystemMessage() { return s; },
                withTools() { return s; },
                withMemory() { return s; },
                withTodos() { return s; },
                withParameters() { return s; },
                /** @param {{initialInput: any}} arg0 */
                run: ({ initialInput }) => isObjectiveRestatePrompt({ input: initialInput })
                    ? Promise.resolve('')
                    : runImpl(asText(initialInput)),
            };
            sessions.push(s);
            return s;
        },
    };
}

/** @param {any} text @returns {string} */
const asText = (text) => {
    if (typeof text === 'string') return text;
    if (Array.isArray(text)) {
        return text.map((m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''))).join('\n');
    }
    return JSON.stringify(text);
};

/**
 * Runs a plan and returns the executor plus the captured prompts per step marker.
 * @param {{steps: any[], runImpl: (text: string) => Promise<any>, options?: any}} arg0
 */
async function runPlan({ steps, runImpl, options = {} }) {
    const client = makeClient({ runImpl });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', ...options } });
    /** @type {any[]} */
    const warnings = [];
    executor.on(EVENTS.WORKFLOW.TEMPLATE_WARNING, (/** @type {any} */ e) => warnings.push(e));
    executor.setSteps({ stepsList: steps });
    /** @type {any} */
    const outputs = await executor.execute({ userGoal: 'goal' });
    return { executor, outputs, client, warnings };
}

/** @param {string} prompt @returns {string[]} */
const intakeIds = (prompt) => [...new Set([...prompt.matchAll(/\[Output from Step "([^"]+)"\]/g)]
    .map((m) => m[1]))].sort();

/** @param {string} id @param {string[]} dependencies @param {Record<string, any>} [extra] */
const step = (id, dependencies = [], extra = {}) => ({
    id,
    title: id,
    systemPrompt: 'Be terse.',
    userPromptTemplate: `${id.toUpperCase()}-STEP`,
    dependencies,
    ...extra,
});

// ─── The leak: intake 'all' across a concurrent sibling ────────────────────

test('W7C1/intake-all: a retry does not absorb a sibling that finished while it waited', async () => {
    /** @type {string[]} */
    const bPrompts = [];
    /** @type {(() => void)|null} */
    let signalBStarted = null;
    const bStarted = new Promise((resolve) => { signalBStarted = () => resolve(undefined); });

    /** @param {string} text */
    const runImpl = async (text) => {
        const t = asText(text);
        if (t.includes('A-STEP')) return 'A-OUT';
        if (t.includes('X-STEP')) {
            // X finishes only AFTER B's first prompt was built and its run began.
            await bStarted;
            return 'X-OUT';
        }
        if (t.includes('B-STEP')) {
            bPrompts.push(t);
            if (bPrompts.length === 1) {
                signalBStarted?.();
                await new Promise((resolve) => setImmediate(resolve));
                return 'bad';
            }
            return 'good';
        }
        return 'unknown';
    };

    let attempts = 0;
    await runPlan({
        steps: [
            step('a'),
            step('x', ['a']),
            step('b', ['a'], {
                intakeMode: 'all',
                maxRetries: 2,
                verify: (/** @type {any} */ out) => { attempts += 1; return { passed: out === 'good', evidence: out }; },
            }),
        ],
        runImpl,
    });

    assert.equal(attempts, 2, 'the step really retried once');
    assert.equal(bPrompts.length, 2, 'both attempts were captured');
    assert.ok(!bPrompts[1].includes('X-OUT'), 'the retry did not absorb the sibling output');
    assert.ok(!bPrompts[1].includes('[Output from Step "x"]'), 'the sibling is not in the retry intake');
    // A retry replays the previous attempt and appends feedback, so compare the
    // INTAKE SET, not the whole prompt: the retry's intake must be the same.
    assert.deepEqual(intakeIds(bPrompts[1]), intakeIds(bPrompts[0]), 'the intake is identical across attempts');
    assert.deepEqual(intakeIds(bPrompts[1]), ['a'], 'and holds exactly the ancestor');
});

// ─── The leak: a non-ancestor template reference ───────────────────────────

test('W7C1/template-non-ancestor: a sibling reference is a plan-time error, and still unresolved if it reaches a run', async () => {
    /** @type {string[]} */
    const bPrompts = [];
    const client = makeClient({ runImpl: async (text) => {
        const t = asText(text);
        if (t.includes('A-STEP')) return 'A-OUT';
        if (t.includes('X-STEP')) return 'X-OUT';
        if (t.includes('B-STEP')) { bPrompts.push(t); return 'B-DONE'; }
        return 'unknown';
    } });
    const stepsList = [
        step('a'),
        step('x'),
        step('b', ['a'], { userPromptTemplate: 'B-STEP use {{x.output}}' }),
    ];
    const strict = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    assert.throws(() => strict.setSteps({ stepsList }), /Plan rejected: .*non-ancestor.*\{\{x\.output\}\}.*step 'b'/);
    assert.equal(strict.steps.size, 0, 'a plan that would read a sibling is not installed');

    // The runtime path stays as the backstop: a plan installed with validation off
    // (or a checkpoint restored without re-validation) still never leaks the output.
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', validateTemplateRefs: false } });
    /** @type {any[]} */
    const warnings = [];
    executor.on(EVENTS.WORKFLOW.TEMPLATE_WARNING, (/** @type {any} */ e) => warnings.push(e));
    executor.setSteps({ stepsList });
    await executor.execute({ userGoal: 'goal' });

    assert.equal(bPrompts.length, 1);
    assert.ok(!bPrompts[0].includes('X-OUT'), 'a non-ancestor output never reaches the prompt');
    assert.ok(bPrompts[0].includes('[UNRESOLVED: {{x.output}}]'), 'the reference is visibly unresolved');
    const warning = warnings.find((w) => w?.referencedStepId === 'x');
    assert.ok(warning, 'the warning names the step');
    assert.match(String(warning.message), /is not an ancestor/, 'and says WHY it is unavailable');
});

test('W7C1/template-transitive: a transitive ancestor still resolves', async () => {
    /** @type {string[]} */
    const cPrompts = [];
    await runPlan({
        steps: [
            step('a'),
            step('b', ['a']),
            step('c', ['b'], { userPromptTemplate: 'C-STEP use {{a.output}}' }),
        ],
        runImpl: async (text) => {
            const t = asText(text);
            if (t.includes('A-STEP')) return 'A-OUT';
            if (t.includes('B-STEP')) return 'B-OUT';
            if (t.includes('C-STEP')) { cPrompts.push(t); return 'C-DONE'; }
            return 'unknown';
        },
    });
    assert.ok(cPrompts[0].includes('A-OUT'), 'a grandparent output is still available');
});

// ─── The leak: intake 'some' with a non-ancestor entry ─────────────────────

test('W7C1/intake-some: an explicit non-ancestor intake step is dropped and reported', async () => {
    /** @type {string[]} */
    const bPrompts = [];
    const { warnings } = await runPlan({
        steps: [
            step('a'),
            step('x'),
            step('b', ['a'], { intakeMode: 'some', intakeSteps: ['a', 'x'] }),
        ],
        runImpl: async (text) => {
            const t = asText(text);
            if (t.includes('A-STEP')) return 'A-OUT';
            if (t.includes('X-STEP')) return 'X-OUT';
            if (t.includes('B-STEP')) { bPrompts.push(t); return 'B-DONE'; }
            return 'unknown';
        },
    });
    assert.ok(bPrompts[0].includes('[Output from Step "a"]'), 'the ancestor intake is kept');
    assert.ok(!bPrompts[0].includes('X-OUT'), 'the non-ancestor intake is dropped');
    const report = warnings.find((w) => w?.path === 'intakeSteps');
    assert.ok(report, 'the drop is reported, not silent');
    assert.deepEqual(report.dropped, ['x'], 'and names the dropped step');
});

// ─── Invariants that must hold in both trees ───────────────────────────────

test('W7C1/intake-dependencies: the default mode still carries the direct deps only', async () => {
    /** @type {string[]} */
    const bPrompts = [];
    await runPlan({
        steps: [step('a'), step('x'), step('b', ['a'])],
        runImpl: async (text) => {
            const t = asText(text);
            if (t.includes('A-STEP')) return 'A-OUT';
            if (t.includes('X-STEP')) return 'X-OUT';
            if (t.includes('B-STEP')) { bPrompts.push(t); return 'B-DONE'; }
            return 'unknown';
        },
    });
    assert.ok(bPrompts[0].includes('[Output from Step "a"]'), 'the dependency is in the intake');
    assert.ok(!bPrompts[0].includes('X-OUT'), 'the sibling is not');
});

test('W7C1/intake-none: no intake block at all', async () => {
    /** @type {string[]} */
    const bPrompts = [];
    await runPlan({
        steps: [step('a'), step('b', ['a'], { intakeMode: 'none' })],
        runImpl: async (text) => {
            const t = asText(text);
            if (t.includes('A-STEP')) return 'A-OUT';
            if (t.includes('B-STEP')) { bPrompts.push(t); return 'B-DONE'; }
            return 'unknown';
        },
    });
    assert.ok(!bPrompts[0].includes('Upstream Step Context'), 'no intake section');
    assert.ok(!bPrompts[0].includes('A-OUT'), 'no ancestor output either');
});

test('W7C1/intake-all-empty: intake "all" on a step with no ancestors warns instead of silently emptying', async () => {
    const client = makeClient({ runImpl: async () => 'out' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    /** @type {any[]} */
    const warnings = [];
    executor.on(EVENTS.WORKFLOW.TEMPLATE_WARNING, (/** @type {any} */ e) => warnings.push(e));
    executor.setSteps({ stepsList: [step('a'), step('root', [], { intakeMode: 'all' })] });
    const a = /** @type {any} */ (executor.steps.get('a'));
    a.status = 'completed';
    const root = /** @type {any} */ (executor.steps.get('root'));
    const targets = executor._selectIntakeTargets({ node: root });
    assert.deepEqual(targets, [], 'a step with no ancestors gets no intake');
    const warning = warnings.find((w) => w?.path === 'intakeMode');
    assert.ok(warning, 'the empty intake is reported');
    assert.match(String(warning.message), /has no ancestors/);
});

test('W7C1/select-targets: the selector itself is ancestor-bounded', async () => {
    const client = makeClient({ runImpl: async () => 'out' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [step('a'), step('x'), step('b', ['a']), step('c', ['b'])] });
    const statuses = { a: 'completed', x: 'completed', b: 'completed', c: 'running' };
    for (const [id, status] of Object.entries(statuses)) {
        const node = executor.steps.get(id);
        if (node) node.status = status;
    }
    const c = /** @type {any} */ (executor.steps.get('c'));
    const all = executor._selectIntakeTargets({ node: { ...c, intakeMode: 'all' } }).map((/** @type {any} */ s) => s.id).sort();
    assert.deepEqual(all, ['a', 'b'], 'transitive ancestors only, never the sibling x');
    const bNode = /** @type {any} */ (executor.steps.get('b'));
    const bAll = executor._selectIntakeTargets({ node: { ...bNode, intakeMode: 'all' } }).map((/** @type {any} */ s) => s.id).sort();
    assert.deepEqual(bAll, ['a'], 'the direct parent only');
    const some = executor._selectIntakeTargets({ node: { ...c, intakeMode: 'some', intakeSteps: ['x', 'b'] } }).map((/** @type {any} */ s) => s.id).sort();
    assert.deepEqual(some, ['b'], 'an explicit non-ancestor is dropped');
    const deps = executor._selectIntakeTargets({ node: c }).map((/** @type {any} */ s) => s.id).sort();
    assert.deepEqual(deps, ['b'], 'the default mode is direct dependencies');
});
