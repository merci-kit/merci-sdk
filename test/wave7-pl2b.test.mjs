// @ts-check

/**
 * Wave 7 / PL2b — evaluation of where the run is, and replanning by patch.
 *
 * The per-step evaluator only ever saw one node. A plan evaluator sees the whole
 * guiding plan plus `progress`, and answers `continue` / `replan` (with a patch) /
 * `done` / `abort`. A patch names the edit, so every node it does not name keeps the
 * definition it already had — a whole-list rewrite is how a replan silently dropped
 * tools, HITL, timeouts and verify functions from untouched nodes.
 *
 * The pure module checks import lazily so the executor checks still run against a
 * tree that has no `plan-patch.mjs` (that is the check-first evidence).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';
import { getLimits, setLimits } from '../lib/core/limit-config.mjs';

/** @param {string} key @returns {number} */
function limitsValue(key) {
    return Number(getLimits().find((/** @type {any} */ entry) => entry.key === key)?.value);
}

/** @param {any} text @returns {string} */
function asText(text) {
    if (typeof text === 'string') return text;
    if (Array.isArray(text)) return text.map((m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? m))).join('\n');
    return JSON.stringify(text);
}

/** @param {{answer?: (text: string, n: number) => string}} [arg0] */
function makeClient({ answer = () => 'OUT' } = {}) {
    /** @type {any[]} */
    const sessions = [];
    const client = {
        sessions,
        getProfiles: async () => [{ id: 'm' }],
        session(/** @type {string} */ model) {
            const s = /** @type {any} */ ({
                provider: 'openai',
                model,
                runs: 0,
                withSystemMessage() { return s; },
                withTools() { return s; },
                withMemory() { return s; },
                withTodos() { return s; },
                withParameters() { return s; },
                withPromptCache() { return s; },
                run(/** @type {{initialInput: any}} */ { initialInput }) {
                    const rows = Array.isArray(initialInput) ? initialInput : [initialInput];
                    const text = asText(rows.at(-1)?.content ?? initialInput);
                    s.runs += 1;
                    if (isObjectiveRestatePrompt({ input: initialInput })) return Promise.resolve('');
                    return Promise.resolve(answer(text, s.runs));
                },
            });
            sessions.push(s);
            return s;
        },
    };
    return client;
}

/** @param {string} id @param {string[]} [dependencies] @param {Record<string, any>} [extra] */
const step = (id, dependencies = [], extra = {}) => ({
    id,
    title: id,
    brief: `${id} is done`,
    systemPrompt: `Be terse (${id}).`,
    userPromptTemplate: `${id.toUpperCase()}-STEP`,
    dependencies,
    ...extra,
});

/** @param {any} client @param {Record<string, any>} [options] */
function executorFor(client, options = {}) {
    return new WorkflowExecutor({ options: { client, defaultModel: 'm', ...options } });
}

// ─── the pure patch module ──────────────────────────────────────────────────

test('PL2b/patch-add: a node is added and untouched nodes keep their definition', async () => {
    const { applyPlanPatch } = await import('../lib/agentic/planning/plan-patch.mjs');
    const a = { ...step('a'), status: 'completed', output: 'A', tools: [{ name: 't' }] };
    const b = { ...step('b', ['a']), status: 'pending' };
    const out = applyPlanPatch({ steps: [a, b], patch: { ops: [{ op: 'add', node: step('c', ['a']) }] } });
    assert.deepEqual(out.rejected, []);
    assert.deepEqual(out.steps.map((s) => s.id), ['a', 'b', 'c']);
    assert.deepEqual(out.steps[1], b, 'an untouched node is carried verbatim');
    assert.deepEqual(out.applied.map((o) => o.op), ['add']);
});

test('PL2b/patch-remove: a pending node is removed, and a dependant makes the patch invalid', async () => {
    const { applyPlanPatch } = await import('../lib/agentic/planning/plan-patch.mjs');
    const steps = [{ ...step('a'), status: 'pending' }, { ...step('b', ['a']), status: 'pending' }];
    const ok = applyPlanPatch({ steps, patch: { ops: [{ op: 'remove', id: 'a' }] } });
    assert.equal(ok.rejected.length, 1);
    assert.match(ok.rejected[0].error, /dangling dependencies .*b→a/);
    assert.deepEqual(ok.steps.map((s) => s.id), ['a', 'b'], 'a rejected patch changes nothing');
    const removed = applyPlanPatch({ steps, patch: { ops: [{ op: 'remove', id: 'b' }] } });
    assert.deepEqual(removed.steps.map((s) => s.id), ['a']);
});

test('PL2b/patch-remove-completed: evidence cannot be removed unless the planner authored the list', async () => {
    const { applyPlanPatch } = await import('../lib/agentic/planning/plan-patch.mjs');
    const steps = [{ ...step('a'), status: 'completed', output: 'A' }, { ...step('b'), status: 'pending' }];
    const rejected = applyPlanPatch({ steps, patch: { ops: [{ op: 'remove', id: 'a' }] } });
    assert.match(rejected.rejected[0].error, /is completed — its evidence cannot be removed/);
    const allowed = applyPlanPatch({ steps, patch: { ops: [{ op: 'remove', id: 'a' }] }, allowRemoveCompleted: true });
    assert.deepEqual(allowed.steps.map((s) => s.id), ['b']);
});

test('PL2b/patch-rewire: dependencies change and the dependants are untouched', async () => {
    const { applyPlanPatch } = await import('../lib/agentic/planning/plan-patch.mjs');
    const steps = [{ ...step('a'), status: 'pending' }, { ...step('b', ['a']), status: 'pending' }, { ...step('c', ['b']), status: 'pending' }];
    const out = applyPlanPatch({ steps, patch: { ops: [{ op: 'rewire', id: 'b', dependsOn: [] }] } });
    assert.deepEqual(out.steps.find((s) => s.id === 'b')?.dependencies, []);
    assert.deepEqual(out.steps.find((s) => s.id === 'c')?.dependencies, ['b']);
});

test('PL2b/patch-replace: only the named fields change; an omitted field survives', async () => {
    const { applyPlanPatch } = await import('../lib/agentic/planning/plan-patch.mjs');
    const a = { ...step('a', [], { tools: [{ name: 'keep-me' }], hitl: { required: true } }), status: 'pending' };
    const out = applyPlanPatch({ steps: [a], patch: { ops: [{ op: 'replace', id: 'a', node: { userPromptTemplate: 'NEW' } }] } });
    assert.equal(out.steps[0].userPromptTemplate, 'NEW');
    assert.deepEqual(out.steps[0].tools, [{ name: 'keep-me' }]);
    assert.deepEqual(out.steps[0].hitl, { required: true });
});

test('PL2b/patch-split: a pending node becomes a chain and dependants attach to the leaf', async () => {
    const { applyPlanPatch } = await import('../lib/agentic/planning/plan-patch.mjs');
    const steps = [
        { ...step('a'), status: 'pending' },
        { ...step('b', ['a']), status: 'pending' },
        { ...step('c', ['b']), status: 'pending' },
    ];
    const out = applyPlanPatch({ steps, patch: { ops: [{ op: 'split', id: 'b', nodes: [step('b1'), step('b2')] }] } });
    assert.deepEqual(out.steps.map((s) => s.id), ['a', 'b1', 'b2', 'c']);
    assert.deepEqual(out.steps.find((s) => s.id === 'b1')?.dependencies, ['a'], 'the first successor inherits the target dependencies');
    assert.deepEqual(out.steps.find((s) => s.id === 'b2')?.dependencies, ['b1'], 'the successors are chained');
    assert.deepEqual(out.steps.find((s) => s.id === 'c')?.dependencies, ['b2'], 'the dependant attached to the leaf');
    const completed = applyPlanPatch({ steps: steps.map((s) => (s.id === 'b' ? { ...s, status: 'completed', output: 'B' } : s)), patch: { ops: [{ op: 'split', id: 'b', nodes: [step('b1'), step('b2')] }] } });
    assert.match(completed.rejected[0].error, /only a pending node can be split/);
});

test('PL2b/patch-expand: a decompose node receives its sub-plan', async () => {
    const { applyPlanPatch } = await import('../lib/agentic/planning/plan-patch.mjs');
    const steps = [{ ...step('a'), status: 'pending' }];
    const out = applyPlanPatch({ steps, patch: { ops: [{ op: 'expand', id: 'a', steps: [step('a1'), step('a2')] }] } });
    assert.deepEqual(/** @type {any} */ (out.steps[0]).subSteps.map((/** @type {any} */ s) => s.id), ['a1', 'a2']);
    const empty = applyPlanPatch({ steps, patch: { ops: [{ op: 'expand', id: 'a', steps: [] }] } });
    assert.match(empty.rejected[0].error, /non-empty array/);
});

test('PL2b/patch-all-or-nothing: one bad op applies none of the patch', async () => {
    const { applyPlanPatch } = await import('../lib/agentic/planning/plan-patch.mjs');
    const steps = [{ ...step('a'), status: 'pending' }];
    const out = applyPlanPatch({ steps, patch: { ops: [
        { op: 'add', node: step('b') },
        { op: 'rewire', id: 'ghost', dependsOn: [] },
    ] } });
    assert.equal(out.rejected.length, 1);
    assert.deepEqual(out.applied, []);
    assert.deepEqual(out.steps.map((s) => s.id), ['a'], 'the good op did not land either');
});

test('PL2b/diff: an identical re-description produces no op, an omission a remove', async () => {
    const { diffStepsToPatch } = await import('../lib/agentic/planning/plan-patch.mjs');
    const a = { ...step('a'), status: 'completed', output: 'A', _stepFingerprint: undefined };
    const b = { ...step('b', ['a']), status: 'pending' };
    const c = { ...step('c'), status: 'pending' };
    const patch = diffStepsToPatch({ previous: [a, b, c], next: [step('a'), step('b', ['a'])] });
    assert.deepEqual(patch.ops.filter((o) => o.op === 'replace'), [], 'unchanged definitions are not rewritten');
    assert.deepEqual(patch.ops.map((o) => `${o.op}:${o.id ?? ''}`), ['remove:c']);
    const added = diffStepsToPatch({ previous: [a], next: [step('a'), step('d')] });
    assert.deepEqual(added.ops.map((o) => o.op), ['add']);
});

// ─── the plan gate in the executor ──────────────────────────────────────────

test('PL2b/gate-replan: a patch adds a node mid-run and the run completes', async () => {
    /** @type {string[]} */
    const seen = [];
    const client = makeClient({ answer: (text) => { seen.push(text); return 'OUT'; } });
    const ex = executorFor(client);
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    /** @type {any[]} */
    const patched = [];
    ex.on('plan:patched', (/** @type {any} */ e) => patched.push(e));
    let calls = 0;
    ex.planEvaluator = {
            evaluate: async (/** @type {any} */ { progress }) => {
                assert.ok(Array.isArray(progress.completed), 'the evaluator sees progress');
                calls += 1;
                if (calls === 1) {
                    assert.deepEqual(progress.completed.map((/** @type {any} */ c) => c.id), ['a']);
                    assert.deepEqual(progress.pending, ['b']);
                    return { verdict: 'replan', reason: 'needs a check', patch: { ops: [{ op: 'add', node: step('check', ['a']) }] } };
                }
                return { verdict: 'continue' };
            },
        };
    await ex.execute({ userGoal: 'goal' });
    assert.equal(calls, 2, 'evaluated again after the patched wave');
    assert.equal(patched.length, 1);
    assert.deepEqual(patched[0].applied.map((/** @type {any} */ o) => o.op), ['add']);
    assert.ok(seen.some((t) => t.includes('CHECK-STEP')), 'the added node ran');
    assert.ok('a' in ex.outputs && 'b' in ex.outputs && 'check' in ex.outputs);
});

test('PL2b/gate-done: a done verdict settles the plan without running the rest', async () => {
    /** @type {string[]} */
    const seen = [];
    const client = makeClient({ answer: (text) => { seen.push(text); return 'OUT'; } });
    const ex = executorFor(client);
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    ex.planEvaluator = { evaluate: async () => ({ verdict: 'done', reason: 'objective met' }) };
    await ex.execute({ userGoal: 'goal' });
    assert.ok(seen.some((t) => t.includes('A-STEP')));
    assert.equal(seen.some((t) => t.includes('B-STEP')), false, 'the remaining node never ran');
    assert.equal(ex.steps.get('b')?.status, 'pending');
    assert.deepEqual(Object.keys(ex.outputs), ['a']);
});

test('PL2b/gate-abort: an abort verdict fails the run loudly', async () => {
    const client = makeClient();
    const ex = executorFor(client);
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    /** @type {any[]} */
    const failed = [];
    ex.on('workflow:failed', (/** @type {any} */ e) => failed.push(e));
    ex.planEvaluator = { evaluate: async () => ({ verdict: 'abort', reason: 'premise was wrong' }) };
    await assert.rejects(() => ex.execute({ userGoal: 'goal' }), /Plan aborted by the plan evaluator: premise was wrong/);
    assert.equal(failed.length, 1);
});

test('PL2b/gate-invalid-patch: an unappliable patch is journaled and the plan is kept', async () => {
    /** @type {string[]} */
    const seen = [];
    const client = makeClient({ answer: (text) => { seen.push(text); return 'OUT'; } });
    const ex = executorFor(client);
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    /** @type {any[]} */
    const patched = [];
    ex.on('plan:patched', (/** @type {any} */ e) => patched.push(e));
    let calls = 0;
    ex.planEvaluator = {
            evaluate: async () => {
                calls += 1;
                return calls === 1
                    ? { verdict: 'replan', reason: 'bad idea', patch: { ops: [{ op: 'add', node: step('c', ['ghost']) }] } }
                    : { verdict: 'continue' };
            },
        };
    await ex.execute({ userGoal: 'goal' });
    assert.equal(patched[0]?.noop, true);
    assert.match(patched[0].rejected[0].error, /dangling/);
    assert.equal(calls, 2, 'the run kept going');
    assert.ok(seen.some((t) => t.includes('B-STEP')), 'the original plan still completed');
});

test('PL2b/gate-unavailable: a throwing evaluator never wedges the run and is not asked again', async () => {
    const client = makeClient();
    const ex = executorFor(client);
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    let calls = 0;
    ex.planEvaluator = { evaluate: async () => { calls += 1; throw new Error('evaluator down'); } };
    const outputs = /** @type {any} */ (await ex.execute({ userGoal: 'goal' }));
    assert.equal(calls, 1, 'one failure stops the plan gate for this run');
    assert.deepEqual(Object.keys(outputs).sort(), ['a', 'b']);
});

test('PL2b/gate-cap: maxPlanReplans bounds the plan patches', async () => {
    const client = makeClient();
    const ex = executorFor(client, { maxPlanReplans: 0 });
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    /** @type {any[]} */
    const limits = [];
    ex.on('workflow:replan_limit', (/** @type {any} */ e) => limits.push(e));
    /** @type {any[]} */
    const patched = [];
    ex.on('plan:patched', (/** @type {any} */ e) => patched.push(e));
    ex.planEvaluator = { evaluate: async () => ({ verdict: 'replan', reason: 'again', patch: { ops: [{ op: 'add', node: step('c', ['a']) }] } }) };
    await ex.execute({ userGoal: 'goal' });
    assert.equal(limits.length, 1);
    assert.equal(patched.length, 1, 'the capped attempt is journaled');
    assert.equal(patched[0].capped, true);
    assert.deepEqual(patched[0].applied, []);
    assert.equal(ex.steps.has('c'), false);
});

test('PL2b/replan-preserves: a whole-list replan keeps fields the planner omits', async () => {
    const client = makeClient();
    const ex = executorFor(client, { maxReplanCount: 2 });
    const tools = [{ name: 'keep-me', description: 'still here' }];
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'], { tools })] });
    let replans = 0;
    await ex.execute({
        userGoal: 'goal',
        planner: {
            replan: async () => {
                replans += 1;
                // The planner re-describes both nodes WITHOUT `tools` — the field a
                // whole-list rewrite used to drop from the untouched node.
                return { steps: [
                    { ...step('a'), userPromptTemplate: 'A-STEP-2' },
                    { id: 'b', title: 'b', systemPrompt: 'Be terse (b).', userPromptTemplate: 'B-STEP', dependencies: ['a'] },
                ] };
            },
        },
        evaluator: { evaluate: async (/** @type {any} */ { node }) => ({ replanRequired: node.id === 'a' && replans === 0, reason: 'weak' }) },
    });
    assert.equal(replans, 1);
    assert.equal(ex.steps.get('a')?.userPromptTemplate, 'A-STEP-2', 'the planner\'s change to a landed');
    assert.deepEqual(ex.steps.get('b')?.tools, tools, 'the untouched node kept its tools');
});

test('PL2b/gate-cycle: a patch that closes a cycle is rejected, not installed', async () => {
    const client = makeClient();
    const ex = executorFor(client);
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    /** @type {any[]} */
    const patched = [];
    ex.on('plan:patched', (/** @type {any} */ e) => patched.push(e));
    let n = 0;
    ex.planEvaluator = {
        evaluate: async () => {
            n += 1;
            return n === 1
                ? { verdict: 'replan', reason: 'cycle', patch: { ops: [{ op: 'rewire', id: 'a', dependsOn: ['b'] }] } }
                : { verdict: 'continue' };
        },
    };
    await ex.execute({ userGoal: 'goal' });
    assert.equal(patched[0]?.noop, true);
    assert.match(patched[0].rejected[0].error, /not a DAG|cycle/i);
    assert.deepEqual(ex.steps.get('a')?.dependencies, [], 'the working plan is intact');
    assert.equal(ex.steps.get('b')?.status, 'completed', 'the run still completed');
});


// ─── round 2: findings from the independent verification ───────────────────

test('PL2b/patch-history: a dependency on a completed node that became history stays satisfiable', async () => {
    const { applyPlanPatch } = await import('../lib/agentic/planning/plan-patch.mjs');
    const b = { ...step('b', ['a']), status: 'pending' };
    const rejected = applyPlanPatch({ steps: [b], patch: { ops: [{ op: 'add', node: step('n', ['a']) }] } });
    assert.match(rejected.rejected[0].error, /dangling dependencies .*n→a/);
    const ok = applyPlanPatch({ steps: [b], patch: { ops: [{ op: 'add', node: step('n', ['a']) }] }, completedIds: new Set(['a']) });
    assert.deepEqual(ok.rejected, []);
    assert.deepEqual(ok.steps.map((s) => s.id), ['b', 'n']);
});

test('PL2b/gate-after-history: a plan patch still lands after a replan dropped a completed node', async () => {
    // The added node used to depend on the dropped `a`, which is the C-2 bug (a
    // rejected step's history is not evidence). The patch still has to land after
    // the drop, so `audit` is added as its own node; the rest is unchanged.
    /** @type {string[]} */
    const seen = [];
    const client = makeClient({ answer: (text) => { seen.push(text); return 'OUT'; } });
    const ex = executorFor(client, { maxReplanCount: 2 });
    ex.setSteps({ stepsList: [step('a'), step('b'), step('c', ['b'])] });
    /** @type {any[]} */
    const patched = [];
    ex.on('plan:patched', (/** @type {any} */ e) => patched.push(e));
    let verdicts = 0;
    ex.planEvaluator = {
        evaluate: async () => {
            verdicts += 1;
            return verdicts === 1
                ? { verdict: 'replan', reason: 'add an audit node', patch: { ops: [{ op: 'add', node: step('audit') }] } }
                : { verdict: 'continue' };
        },
    };
    await ex.execute({
        userGoal: 'goal',
        planner: { replan: async () => ({ steps: [step('b'), step('c', ['b'])] }) },
        evaluator: { evaluate: async (/** @type {any} */ { node }) => ({ replanRequired: node.id === 'a' && verdicts === 0, reason: 'weak' }) },
    });
    assert.equal(ex.steps.get('a')?.historical, true, 'the replan dropped a to history');
    assert.equal(ex.steps.get('a')?.rejected, true, 'and marked it rejected');
    assert.equal(patched[0]?.noop, undefined, 'the plan patch was applied, not rejected');
    assert.deepEqual(patched[0].applied.map((/** @type {any} */ o) => o.op), ['add']);
    assert.ok(seen.some((t) => t.includes('AUDIT-STEP')), 'the added node ran');
    assert.ok('audit' in ex.outputs);
});

test('PL2b/gate-settled: a done verdict is journaled and names the nodes it skipped', async () => {
    const client = makeClient();
    const ex = executorFor(client);
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    /** @type {any[]} */
    const settled = [];
    /** @type {any[]} */
    const ended = [];
    ex.on('plan:settled', (/** @type {any} */ e) => settled.push(e));
    ex.on('workflow:end', (/** @type {any} */ e) => ended.push(e));
    ex.planEvaluator = { evaluate: async () => ({ verdict: 'done', reason: 'objective met' }) };
    await ex.execute({ userGoal: 'goal' });
    assert.equal(settled.length, 1);
    assert.deepEqual(settled[0].pending, ['b']);
    assert.equal(ended[0].planSettled, true);
    assert.deepEqual(ended[0].pendingSteps, ['b']);
    assert.equal(ended[0].planReplans, 0);
});

test('PL2b/deferred-settle: a plan evaluator done does not abandon deferred verification', async () => {
    const client = makeClient();
    const ex = executorFor(client);
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    /** @type {any[]} */
    const skipped = [];
    ex.on('workflow:verification_skipped', (/** @type {any} */ e) => skipped.push(e));
    ex.planEvaluator = { evaluate: async () => ({ verdict: 'done', reason: 'objective met' }) };
    const outputs = /** @type {any} */ (await ex.execute({
        userGoal: 'goal',
        planner: { replan: async () => ({ steps: [] }) },
        // The step evaluator is down, so 'a' is deferred; the plan then settles.
        evaluator: { evaluate: async () => { throw new Error('step evaluator down'); } },
    }));

    const row = skipped.find((e) => e.stepId === 'a');
    assert.ok(row, 'a deferred verdict the settle left behind is named, not silently dropped');
    assert.equal(row.reason, 'plan settled before step evaluation');
    assert.deepEqual(Object.keys(outputs), ['a'], 'the settled plan still ran only the first wave');
});

test('PL2b/deferred-outage: a raised outage budget is spent, and the reason names the outage', async () => {
    const previous = limitsValue('evaluator_outage_attempts');
    setLimits({ values: { evaluator_outage_attempts: 4 } });
    try {
        const client = makeClient();
        const ex = executorFor(client);
        ex.setSteps({ stepsList: [step('a')] });
        /** @type {any[]} */
        const skipped = [];
        ex.on('workflow:verification_skipped', (/** @type {any} */ e) => skipped.push(e));
        let calls = 0;
        await ex.execute({
            userGoal: 'goal',
            planner: { replan: async () => ({ steps: [] }) },
            evaluator: { evaluate: async () => { calls += 1; throw new Error('down'); } },
        });

        assert.equal(calls, 4, 'the configured outage budget is spent, not two calls');
        const row = skipped.find((e) => e.stepId === 'a');
        assert.ok(row, 'the unverified step is named');
        assert.equal(row.reason, 'Evaluator still unavailable after 4 attempts: down');
        assert.doesNotMatch(row.reason, /plan settled/, 'no plan settled: saying it did is a false reason');
    } finally {
        setLimits({ values: { evaluator_outage_attempts: previous } });
    }
});

test('PL2b/deferred-historical: a dropped step is not evaluated again', async () => {
    /** @type {string[]} */
    const seen = [];
    const client = makeClient({ answer: (text) => {
        if (text.includes('B-STEP')) throw new Error('b failed');
        seen.push(text);
        return 'OUT';
    } });
    const ex = executorFor(client, { maxReplanCount: 1 });
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    /** @type {any[]} */
    const skipped = [];
    ex.on('workflow:verification_skipped', (/** @type {any} */ e) => skipped.push(e));

    /** @type {string[]} */
    const evaluated = [];
    const replanned = { done: false };
    await ex.execute({
        userGoal: 'goal',
        planner: {
            // The replan drops 'a' (completed) and fixes 'b' so the run can end.
            replan: async () => {
                replanned.done = true;
                return { steps: [{ ...step('b'), userPromptTemplate: 'B-SECOND' }] };
            },
        },
        evaluator: {
            evaluate: async (/** @type {any} */ { node }) => {
                evaluated.push(node.id);
                if (node.id === 'a') throw new Error('step evaluator down');
                return { replanRequired: false };
            },
        },
    });

    assert.equal(replanned.done, true, 'the replan that drops the step happened');
    assert.equal(ex.steps.get('a')?.historical, true, "'a' left the plan and became history");
    assert.deepEqual(evaluated, ['a', 'b'], "the dropped step is not evaluated again (today it is: ['a', 'b', 'a'])");
    assert.equal(skipped.some((e) => e.stepId === 'a'), false, 'no verdict event is invented for a dropped step');
    assert.ok(seen.some((t) => t.includes('B-SECOND')), 'the replacement step ran');
});

test('PL2b/patch-template: an evaluator patch with an unknown template reference is rejected', async () => {
    const client = makeClient();
    const ex = executorFor(client);
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    /** @type {any[]} */
    const patched = [];
    ex.on('plan:patched', (/** @type {any} */ e) => patched.push(e));
    let n = 0;
    ex.planEvaluator = {
        evaluate: async () => {
            n += 1;
            return n === 1
                ? { verdict: 'replan', reason: 'bad ref', patch: { ops: [{ op: 'add', node: { ...step('c'), userPromptTemplate: 'uses {{ghost.output}}' } }] } }
                : { verdict: 'continue' };
        },
    };
    await ex.execute({ userGoal: 'goal' });
    assert.equal(patched[0]?.noop, true);
    assert.match(patched[0].rejected[0].error, /Unknown template reference/);
    assert.equal(ex.steps.has('c'), false);
});

test('PL2b/patch-split-self-dep: a successor that depends on the split target is rejected', async () => {
    const { applyPlanPatch } = await import('../lib/agentic/planning/plan-patch.mjs');
    const steps = [{ ...step('a'), status: 'pending' }, { ...step('b', ['a']), status: 'pending' }];
    const out = applyPlanPatch({ steps, patch: { ops: [{ op: 'split', id: 'a', nodes: [{ ...step('a1'), dependencies: ['a'] }] }] } });
    assert.match(out.rejected[0].error, /depends on 'a'/);
    assert.deepEqual(out.steps.map((s) => s.id), ['a', 'b']);
});

test('PL2b/diff-duplicate: a re-described plan with duplicate ids is rejected', async () => {
    const { diffStepsToPatch } = await import('../lib/agentic/planning/plan-patch.mjs');
    assert.throws(() => diffStepsToPatch({ previous: [], next: [step('x'), step('x')] }), /duplicate ids/);
});

test('PL2b/plan-copy: the plan an evaluator receives is a copy, not the live run', async () => {
    const client = makeClient();
    const ex = executorFor(client);
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    ex.planEvaluator = {
        evaluate: async (/** @type {any} */ { plan }) => {
            plan.nodes[0].step.userPromptTemplate = 'HACKED';
            plan.nodes[0].step.dependencies = ['ghost'];
            return { verdict: 'continue' };
        },
    };
    await ex.execute({ userGoal: 'goal' });
    assert.equal(ex.steps.get('a')?.userPromptTemplate, 'A-STEP');
    assert.deepEqual(ex.steps.get('a')?.dependencies, []);
});

test('PL2b/plan-isolated: an evaluator that mutates the plan or the progress cannot touch the run', async () => {
    const client = makeClient();
    const ex = executorFor(client);
    ex.setSteps({ stepsList: [step('a', [], { tools: [{ name: 'keep' }] }), step('b', ['a'])] });
    let calls = 0;
    ex.planEvaluator = {
        evaluate: async (/** @type {any} */ { plan, progress }) => {
            calls += 1;
            if (calls === 1) {
                plan.nodes[0].step.dependencies.push('ghost');
                plan.nodes[0].step.tools.push({ name: 'injected' });
                if (progress.completed[0]?.output && typeof progress.completed[0].output === 'object') {
                    progress.completed[0].output.injected = true;
                }
            }
            return { verdict: 'continue' };
        },
    };
    const outputs = /** @type {any} */ (await ex.execute({ userGoal: 'goal' }));
    assert.deepEqual(ex.steps.get('a')?.dependencies, [], 'the live node is untouched');
    assert.deepEqual(ex.steps.get('a')?.tools, [{ name: 'keep' }]);
    assert.deepEqual(Object.keys(outputs).sort(), ['a', 'b']);
});

test('PL2b/patch-null-deps: a null dependency list means none, as a whole-list plan always did', async () => {
    const { applyPlanPatch } = await import('../lib/agentic/planning/plan-patch.mjs');
    const steps = [{ ...step('a'), status: 'pending' }, { ...step('b', ['a']), status: 'pending' }];
    const out = applyPlanPatch({ steps, patch: { ops: [{ op: 'replace', id: 'b', node: { dependencies: null } }] } });
    assert.deepEqual(out.rejected, []);
    assert.deepEqual(out.steps.find((s) => s.id === 'b')?.dependencies, []);
    const added = applyPlanPatch({ steps, patch: { ops: [{ op: 'add', node: { ...step('c'), dependencies: null } }] } });
    assert.deepEqual(added.rejected, []);
    assert.deepEqual(added.steps.find((s) => s.id === 'c')?.dependencies, []);
});

test('PL2b/patch-history-template: a patch may not read the output of a step a replan rejected', async () => {
    // This test used to prove the opposite — that a patch could read the output of
    // a node a replan dropped — which is the C-2 bug: the run had refused that
    // output. The positive rule now: rejected history is not evidence, so the patch
    // is refused by name and the working plan keeps running.
    /** @type {string[]} */
    const seen = [];
    const client = makeClient({ answer: (text) => { seen.push(text); return 'OUT'; } });
    const ex = executorFor(client, { maxReplanCount: 2 });
    ex.setSteps({ stepsList: [step('a'), step('b'), step('c', ['b'])] });
    /** @type {any[]} */
    const patched = [];
    ex.on('plan:patched', (/** @type {any} */ e) => patched.push(e));
    let verdicts = 0;
    ex.planEvaluator = {
        evaluate: async () => {
            verdicts += 1;
            return verdicts === 1
                ? { verdict: 'replan', reason: 'audit it', patch: { ops: [{ op: 'add', node: { ...step('audit', ['a']), userPromptTemplate: 'AUDIT {{a.output}}' } }] } }
                : { verdict: 'continue' };
        },
    };
    await ex.execute({
        userGoal: 'goal',
        planner: { replan: async () => ({ steps: [step('b'), step('c', ['b'])] }) },
        evaluator: { evaluate: async (/** @type {any} */ { node }) => ({ replanRequired: node.id === 'a' && verdicts === 0, reason: 'weak' }) },
    });
    assert.equal(ex.steps.get('a')?.historical, true);
    assert.equal(ex.steps.get('a')?.rejected, true, 'the dropped step is refused evidence');
    assert.equal(patched[0]?.noop, true, 'the patch is refused, not applied');
    assert.match(patched[0].rejected[0].error, /dangling dependencies .*audit→a/);
    assert.equal(ex.steps.has('audit'), false, 'the working plan is intact');
    assert.equal(seen.some((t) => t.includes('AUDIT')), false, 'no prompt was built from the rejected output');
    assert.equal(ex.steps.get('b')?.status, 'completed', 'the run still finished');
});

test('PL2b/rejected-patch-quiet: a rejected patch does not emit workflow:failed', async () => {
    const client = makeClient();
    const ex = executorFor(client);
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    /** @type {any[]} */
    const failed = [];
    ex.on('workflow:failed', (/** @type {any} */ e) => failed.push(e));
    let n = 0;
    ex.planEvaluator = {
        evaluate: async () => {
            n += 1;
            return n === 1
                ? { verdict: 'replan', reason: 'bad', patch: { ops: [{ op: 'add', node: { ...step('c'), userPromptTemplate: '{{ghost.output}}' } }] } }
                : { verdict: 'continue' };
        },
    };
    await ex.execute({ userGoal: 'goal' });
    assert.equal(failed.length, 0, 'a rejected edit is not a failed run');
    assert.equal(ex.steps.get('b')?.status, 'completed');
});

test('PL2b/settled-resume: a settled plan stays settled across a checkpoint', async () => {
    const client = makeClient();
    const ex = executorFor(client);
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    ex.planEvaluator = { evaluate: async () => ({ verdict: 'done', reason: 'objective met' }) };
    await ex.execute({ userGoal: 'goal' });
    assert.equal(ex.steps.get('b')?.status, 'pending');

    const restored = WorkflowExecutor.load({ json: ex.save(), options: { client, defaultModel: 'm' } });
    let ran = 0;
    restored.on('workflow:step_start', (/** @type {any} */ e) => { if (e.stepId === 'b') ran += 1; });
    await restored.execute({ userGoal: 'goal' });
    assert.equal(ran, 0, 'the skipped node is not resurrected by a resume');
    assert.equal(restored.steps.get('b')?.status, 'pending');
});

test('PL2b/replan-duplicate-journaled: a planner response with duplicate ids is journaled, not a crash', async () => {
    const client = makeClient();
    const ex = executorFor(client, { maxReplanCount: 2 });
    ex.setSteps({ stepsList: [step('a')] });
    /** @type {any[]} */
    const patched = [];
    ex.on('plan:patched', (/** @type {any} */ e) => patched.push(e));
    await assert.rejects(
        () => ex.execute({
            userGoal: 'goal',
            planner: { replan: async () => ({ steps: [step('x'), step('x')] }) },
            evaluator: { evaluate: async () => ({ replanRequired: true, reason: 'weak' }) },
        }),
        /Replan rejected: .*duplicate ids/
    );
    assert.equal(patched.length, 1);
    assert.match(patched[0].rejected[0].error, /duplicate ids/);
});

test('PL2b/settled-reopen: setSteps with new work reopens a settled plan; re-supplying it does not', async () => {
    /** @type {string[]} */
    const seen = [];
    const client = makeClient({ answer: (text) => { seen.push(text); return 'OUT'; } });
    const ex = executorFor(client);
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    ex.planEvaluator = { evaluate: async () => ({ verdict: 'done', reason: 'objective met' }) };
    await ex.execute({ userGoal: 'goal' });
    assert.equal(ex.steps.get('b')?.status, 'pending');

    // Re-supplying the same plan keeps the settlement (the restore path).
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    assert.equal(/** @type {any} */ (ex)._planSettled, true, 'the same plan does not reopen a settled run');

    // Adding work does.
    ex.setSteps({ stepsList: [step('a'), step('b', ['a']), step('c', ['b'])] });
    assert.equal(/** @type {any} */ (ex)._planSettled, false, 'new work reopens the plan');
    ex.planEvaluator = { evaluate: async () => ({ verdict: 'continue' }) };
    seen.length = 0;
    await ex.execute({ userGoal: 'goal' });
    assert.ok(seen.some((t) => t.includes('C-STEP')), 'the new node runs');
    assert.equal(ex.steps.get('c')?.status, 'completed');
});

test('PL2b/replan-history-template: a replan may not leave a dependent reading the step it dropped', async () => {
    // This test used to prove the opposite — a replan dropping `a` while `b` kept
    // reading `{{a.output}}` — which is the C-2 bug: the run had refused `a`. The
    // rewrite is now refused by name, the rejected step re-runs, and `b` reads the
    // replacement instead of the refused output.
    /** @type {string[]} */
    const seen = [];
    const client = makeClient({ answer: (text) => { seen.push(text); return 'OUT'; } });
    const ex = executorFor(client, { maxReplanCount: 2 });
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    /** @type {any[]} */
    const patched = [];
    ex.on('plan:patched', (/** @type {any} */ e) => patched.push(e));
    let replans = 0;
    await ex.execute({
        userGoal: 'goal',
        planner: {
            replan: async () => {
                replans += 1;
                // `a` is dropped from the list (it becomes history) but `b` still uses its output.
                return { steps: [{ ...step('b', ['a']), userPromptTemplate: 'B2 {{a.output}}' }] };
            },
        },
        evaluator: { evaluate: async (/** @type {any} */ { node }) => ({ replanRequired: node.id === 'a' && replans === 0, reason: 'weak' }) },
    });
    assert.equal(replans, 1);
    assert.notEqual(ex.steps.get('a')?.historical, true, 'the working plan keeps the rejected step');
    const refusal = patched.find((e) => e.rejected?.length > 0);
    assert.ok(refusal, 'the rewrite is refused, visibly');
    assert.equal(refusal.noop, true);
    assert.match(refusal.rejected[0].error, /'a'/);
    assert.match(refusal.rejected[0].error, /b→a/);
    assert.equal(seen.some((t) => t.includes('B2')), false, 'the refused template never reaches the model');
    assert.ok(seen.some((t) => t.includes('B-STEP')), 'the dependent re-ran against the current plan');
    assert.equal(ex.steps.get('b')?.status, 'completed', 'the run still finished');
});

test('PL2b/resume-budget: the plan-replan budget and a stopped evaluator ride the checkpoint', async () => {
    const client = makeClient();
    const ex = executorFor(client, { maxPlanReplans: 2 });
    ex.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    let n = 0;
    ex.planEvaluator = {
        evaluate: async () => {
            n += 1;
            return n === 1
                ? { verdict: 'replan', reason: 'once', patch: { ops: [{ op: 'add', node: step('c', ['a']) }] } }
                : { verdict: 'continue' };
        },
    };
    await ex.execute({ userGoal: 'goal' });
    const restored = WorkflowExecutor.load({ json: ex.save(), options: { client, defaultModel: 'm', maxPlanReplans: 2 } });
    assert.equal(/** @type {any} */ (restored)._planReplans, 1);
    assert.equal(/** @type {any} */ (restored)._planEvalStopped, false);
});
