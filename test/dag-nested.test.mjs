// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';
import { EVENTS, RunContext } from '../lib/core/events.mjs';
import { LIMITS } from '../lib/core/limit-config.mjs';

const SIMPLE_STEP = {
    id: 'outer',
    title: 'Outer',
    systemPrompt: 'Be terse.',
    userPromptTemplate: 'outer prompt',
    dependencies: [],
};


/** @param {{input: *}} arg0 */
function userText({ input }) {
    const rows = Array.isArray(input) ? input : [input];
    const last = rows[rows.length - 1];
    return typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
}


/**
 * session so a test can inspect the fields runStep set on it.
 * @param {{runImpl: (input: any, options: any, session: any) => Promise<any>}} arg0 -
 */
function makeFakeClient({ runImpl }) {
    
    /** @type {any[]} */
        const sessions = [];
    return {
        sessions,
        session: () => {
            
            /** @type {any} */
                        const s = {
                provider: 'openai',
                withSystemMessage() { return this; },
                withTools() { return this; },
                withMemory() { return this; },
                withTodos() { return this; },
                withParameters() { return this; },
                /** @param {{initialInput: *, options: *}} arg0 */
                run: ({ initialInput: input, options }) =>
                    isObjectiveRestatePrompt({ input }) ? Promise.resolve('') : runImpl(input, options, s),
            };
            sessions.push(s);
            return s;
        },
    };
}

// ─── engine:'dag' runs a nested child DAG and records its leaf output ───────

test('D19: a step with engine:"dag" runs its subSteps and records the leaf output', async () => {
    
    /** @type {string[]} */
        const seen = [];
    const client = makeFakeClient({ runImpl: async (input) => {
        const text = userText({ input });
        seen.push(text);
        if (text.includes('do x2')) return 'leaf-x2';
        return `echo:${text.slice(0, 24)}`;
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 0 } });
    executor.setSteps({ stepsList: [{
        ...SIMPLE_STEP,
        engine: 'dag',
        subSteps: [
            { id: 'x1', userPromptTemplate: 'do x1', dependencies: [] },
            { id: 'x2', userPromptTemplate: 'do x2', dependencies: ['x1'] },
        ],
    }] });

    await executor.execute({ userGoal: 'goal' });

    assert.equal(( (/** @type {any} */ (executor.steps))).get('outer').status, 'completed');
    assert.equal(executor.outputs['outer'].output, 'leaf-x2', 'the leaf of the nested DAG is the step output');
    assert.ok(seen.some((t) => t.includes('do x1')), 'nested step x1 ran');
    assert.ok(seen.some((t) => t.includes('do x2')), 'nested step x2 ran');
});

test('D19: a nested-DAG step accepts a static sub-plan without a planner', async () => {
    const client = makeFakeClient({ runImpl: async (input) => {
        const text = userText({ input });
        if (text.includes('only step')) return 'static-leaf';
        return `outer-echo:${text.slice(0, 16)}`;
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 0 } });
    executor.setSteps({ stepsList: [{
        ...SIMPLE_STEP,
        engine: 'dag',
        subSteps: [{ id: 'only', userPromptTemplate: 'only step', dependencies: [] }],
    }] });

    await executor.execute({ userGoal: 'goal' });
    assert.equal(executor.outputs['outer'].output, 'static-leaf');
});

// ─── depth guard ────────────────────────────────────────────────────────────

test('D19: nesting past maxDepth fails the step with a typed depth-limit error', async () => {
    const client = makeFakeClient({ runImpl: async () => 'unused' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 0 } });
    executor.setSteps({ stepsList: [{
        ...SIMPLE_STEP,
        engine: 'dag',
        subSteps: [{
            id: 'inner',
            userPromptTemplate: 'inner',
            engine: 'dag',
            subSteps: [{ id: 'deep', userPromptTemplate: 'deep', dependencies: [] }],
        }],
    }] });

    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /depth limit/);
    assert.equal(( (/** @type {any} */ (executor.steps))).get('outer').status, 'failed');
});

test('D19: maxDepth:2 allows one more level of nesting', async () => {
    const client = makeFakeClient({ runImpl: async (input) => {
        const text = userText({ input });
        if (text.includes('deep')) return 'deep-leaf';
        return `echo:${text.slice(0, 16)}`;
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 0, maxDepth: 2 } });
    executor.setSteps({ stepsList: [{
        ...SIMPLE_STEP,
        engine: 'dag',
        subSteps: [{
            id: 'inner',
            userPromptTemplate: 'inner',
            engine: 'dag',
            subSteps: [{ id: 'deep', userPromptTemplate: 'deep', dependencies: [] }],
        }],
    }] });

    await executor.execute({ userGoal: 'goal' });
    assert.equal(executor.outputs['outer'].output, 'deep-leaf');
});

// ─── shared signal ──────────────────────────────────────────────────────────

test('D19: the nested run shares the parent signal', async () => {
    
    /** @type {Array<{text: string, signal: any}>} */
        const calls = [];
    const client = makeFakeClient({ runImpl: async (input, options) => {
        calls.push({ text: userText({ input }), signal: options?.signal });
        return 'ok';
    } });
    const controller = new AbortController();
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 0, signal: controller.signal } });
    executor.setSteps({ stepsList: [{
        ...SIMPLE_STEP,
        engine: 'dag',
        subSteps: [{ id: 'x1', userPromptTemplate: 'child-prompt', dependencies: [] }],
    }] });

    await executor.execute({ userGoal: 'goal' });
    const childCall = calls.find((c) => c.text.includes('child-prompt'));
    assert.ok(childCall, 'the nested step ran');
    assert.equal(childCall.signal, controller.signal, 'the nested step session received the parent signal');
});

// ─── shared direction ───────────────────────────────────────────────────────

test('D19: the nested run inherits the parent AgentContext (shared direction)', async () => {
    
    /** @type {Array<{text: string, ctx: any}>} */
        const calls = [];
    const client = makeFakeClient({ runImpl: async (input, _options, session) => {
        calls.push({ text: userText({ input }), ctx: session._agentContext });
        return 'ok';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 0 } });
    executor.setSteps({ stepsList: [{
        ...SIMPLE_STEP,
        engine: 'dag',
        subSteps: [{ id: 'x1', userPromptTemplate: 'child-prompt', dependencies: [] }],
    }] });

    await executor.execute({ userGoal: 'goal' });
    const childCall = calls.find((c) => c.text.includes('child-prompt'));
    assert.ok(childCall, 'the nested step ran');
    // Wave 12 / D6: a step gets a VIEW of the run context (deep-copied refs, so a
    // sibling cannot see a mutation), not the same mutable object. The direction is
    // still shared: the run context is in the view's parent chain and the objective
    // is inherited.
    assert.ok(childCall.ctx, 'the nested step got a context');
    assert.equal(childCall.ctx.objective, /** @type {any} */ (executor)._agentContext.objective,
        'the objective is inherited');
    let chain = childCall.ctx;
    let reaches = false;
    while (chain) { if (chain === executor._agentContext) { reaches = true; break; } chain = chain.parent; }
    assert.ok(reaches, 'the run context is in the view\'s parent chain');
    assert.notEqual(childCall.ctx, executor._agentContext, 'and the view is not the run object itself');
});

// ─── failure propagation (never swallowed) ──────────────────────────────────

test('D19: a failing nested step fails the parent step and rejects execute()', async () => {
    const client = makeFakeClient({ runImpl: async (input) => {
        if (userText({ input }).includes('boom')) throw new Error('kaboom');
        return 'ok';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 0 } });
    executor.setSteps({ stepsList: [{
        ...SIMPLE_STEP,
        engine: 'dag',
        subSteps: [{ id: 'x1', userPromptTemplate: 'boom please', dependencies: [] }],
    }] });

    await assert.rejects(() => executor.execute({ userGoal: 'goal' }), /kaboom/);
    assert.equal(( (/** @type {any} */ (executor.steps))).get('outer').status, 'failed');
    assert.match(String(executor.outputs['outer'].output), /kaboom/);
});

/**
 * The steps of a replan prompt: `planSnapshot` hands the planner an array.
 * @param {any} plan
 * @returns {any[]}
 */
function planSteps(plan) {
    if (Array.isArray(plan)) return plan;
    if (Array.isArray(plan?.steps)) return plan.steps;
    return [];
}

/**
 * Re-describes the given plan's steps with one user prompt (the shape a planner
 * returns: a whole list of definitions).
 * @param {any} plan
 * @param {string|null} prompt null keeps each step's own prompt
 * @returns {any[]}
 */
function rewritePlan(plan, prompt = null) {
    return planSteps(plan).map((s) => ({
        id: s.id,
        title: s.title,
        systemPrompt: s.systemPrompt,
        userPromptTemplate: prompt ?? s.userPromptTemplate,
        dependencies: s.dependencies ?? [],
    }));
}

// ─── W4-1: concurrent nests split one replan budget ─────────────────────────

test('W4-1: two concurrent nested DAGs split the replan budget instead of each taking it', async () => {
    /** @type {string[]} */
    const replanned = [];
    const client = makeFakeClient({ runImpl: async (input) => {
        if (userText({ input }).includes('leaf-boom')) throw new Error('boom');
        return 'ok';
    } });
    /** @param {{failedStepId: string, plan?: any}} arg0 */
    const planner = {
        plan: async () => ({ steps: [] }),
        /** @param {{failedStepId: string, plan?: any}} arg0 */
        replan: async ({ failedStepId, plan }) => {
            replanned.push(String(failedStepId));
            return { steps: rewritePlan(plan) };
        },
    };
    /** @param {string} id */
    const nest = (id) => ({
        id, title: id, systemPrompt: 'Be terse.', userPromptTemplate: `${id} prompt`,
        engine: 'dag', dependencies: [],
        subSteps: [{ id: `${id}-leaf`, userPromptTemplate: 'leaf-boom', dependencies: [] }],
    });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 1, maxConcurrency: 4 } });
    executor.setSteps({ stepsList: [nest('left'), nest('right')] });

    await assert.rejects(() => executor.execute({ userGoal: 'goal', planner }));
    // Both nests are runnable in the same wave: one may spend the single replan,
    // the other must be granted none (0), not the same remainder twice.
    assert.equal(replanned.length, 1, `one budget, one replan (got ${replanned.length}: ${replanned.join(', ')})`);
    assert.equal(executor._replanCount, 1, 'the run records one replan');
});

// ─── W4-7: a non-finite host cap is not offered to a nested run as NaN ──────

test('W4-7: a non-finite host maxReplanCount does not reach the child as NaN', async () => {
    const client = makeFakeClient({ runImpl: async () => 'ok' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: NaN } });
    executor.setSteps({ stepsList: [{
        ...SIMPLE_STEP,
        engine: 'dag',
        subSteps: [{ id: 'inner', userPromptTemplate: 'inner prompt', dependencies: [] }],
    }] });

    /** @type {number[]} */
    const childCaps = [];
    const ownExecute = WorkflowExecutor.prototype.execute;
    /** @type {any} */
    (WorkflowExecutor.prototype).execute = async function patched(/** @type {any} */ args) {
        if (this !== executor) childCaps.push(Number(this.maxReplanCount));
        return ownExecute.call(this, args);
    };
    try {
        await executor.execute({ userGoal: 'goal' });
    } finally {
        /** @type {any} */
        (WorkflowExecutor.prototype).execute = ownExecute;
    }

    assert.ok(childCaps.length > 0, 'the nested run started');
    assert.ok(childCaps.every((cap) => Number.isFinite(cap)), `the child cap is finite (got ${childCaps.join(', ')})`);
    assert.equal(childCaps[0], LIMITS.max_replan_count, 'a non-finite cap means "the library default", not NaN');
});

// ─── W4-12: a retried nested node keeps no child the parent already charged ──

test('W4-12: a retried nested node does not checkpoint a child the parent already folded in', async () => {
    /** @type {string[]} */
    const seen = [];
    const client = makeFakeClient({ runImpl: async (input) => {
        const text = userText({ input });
        seen.push(text);
        if (text.includes('inner-boom')) throw new Error('inner failed');
        return 'second-answer';
    } });
    /** @param {{failedStepId: string, plan?: any}} arg0 */
    const planner = {
        plan: async () => ({ steps: [] }),
        /** @param {{plan?: any}} arg0 */
        replan: async ({ plan }) => ({ steps: rewritePlan(plan, 'inner-ok') }),
    };
    const controller = new AbortController();
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 1, signal: controller.signal } });
    executor.setSteps({ stepsList: [{
        ...SIMPLE_STEP,
        engine: 'dag',
        subSteps: [{ id: 'inner', userPromptTemplate: 'inner-boom', dependencies: [] }],
        // The retry after the first attempt never starts: the child of attempt 1
        // emits nothing, so its checkpoint cannot overwrite the stale one.
        /** @param {unknown} output */
        verify: (output) => ({ passed: false, evidence: `not this: ${String(output)}` }),
    }] });

    executor.on('workflow:step_verify_fail', () => controller.abort(new Error('stop after the first attempt')));
    await assert.rejects(() => executor.execute({ userGoal: 'goal', planner }), /abort/i);

    const state = JSON.parse(executor.save());
    const outer = state.steps.find((/** @type {any} */ s) => s.id === 'outer');
    assert.equal(outer?._childState, undefined,
        'the child whose replan the parent already counted is cleared before the retry');
    assert.ok(seen.some((t) => t.includes('inner-ok')), 'the child did replan once before the retry');
});

// ─── C-5: one replan budget for the whole nest ──────────────────────────────

test('C-5: nested DAG does not multiply maxReplanCount', async () => {
    /** @type {string[]} */
    const replanned = [];
    const client = makeFakeClient({ runImpl: async (input) => {
        const text = userText({ input });
        if (text.includes('PRE-ONE') || text.includes('leaf-boom')) throw new Error('boom');
        return 'ok';
    } });
    /** @type {Record<string, any>} */
    const DEFS = {
        pre: { id: 'pre', title: 'pre', systemPrompt: 'Be terse.', userPromptTemplate: 'PRE-ONE', dependencies: [] },
        nest: {
            id: 'nest', title: 'nest', systemPrompt: 'Be terse.', userPromptTemplate: 'nest prompt',
            engine: 'dag', dependencies: ['pre'],
            subSteps: [{ id: 'leaf', userPromptTemplate: 'leaf-boom', dependencies: [] }],
        },
    };
    const planner = {
        plan: async () => ({ steps: [] }),
        /** @param {{failedStepId: string, plan?: any}} arg0 */
        replan: async ({ failedStepId, plan }) => {
            replanned.push(String(failedStepId));
            if (failedStepId === 'pre') {
                // The first step is fixed by the rewrite: it no longer trips.
                return { steps: [{ ...DEFS.pre, userPromptTemplate: 'PRE-TWO' }, { ...DEFS.nest }] };
            }
            // A leaf the nested run owns: re-describe its own plan unchanged.
            return { steps: rewritePlan(plan) };
        },
    };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 2 } });
    executor.setSteps({ stepsList: [DEFS.pre, DEFS.nest] });

    await assert.rejects(() => executor.execute({ userGoal: 'goal', planner }));
    // 'pre' spends one replan fixing itself, so the nested run may spend one more —
    // never a fresh two. A per-execution budget would let the nest spend its own 2
    // on top of the parent's 1 and exceed maxReplanCount.
    assert.equal(replanned.length, 2, `the nest shares the run's replan budget (got ${replanned.length}: ${replanned.join(', ')})`);
});

// ─── C-6: the nested run is correlated to the step that started it ──────────

test('C-6: nested DAG run is parented to its step context', async () => {
    const client = makeFakeClient({ runImpl: async (input) => {
        const text = userText({ input });
        return text.includes('inner prompt') ? 'inner-out' : `echo:${text.slice(0, 16)}`;
    } });
    const executor = new WorkflowExecutor({ options: {
        client,
        defaultModel: 'm',
        maxReplanCount: 0,
        runContext: new RunContext({ sessionId: 'sess-1' }),
    } });
    executor.setSteps({ stepsList: [{
        ...SIMPLE_STEP,
        engine: 'dag',
        subSteps: [{ id: 'inner', userPromptTemplate: 'inner prompt', dependencies: [] }],
    }] });

    /** @type {any[]} */
    const starts = [];
    /** @type {any[]} */
    const ends = [];
    /** @type {any[]} */
    const stepStarts = [];
    executor.on(EVENTS.WORKFLOW.STEP_START, (/** @type {any} */ e) => stepStarts.push(e));
    executor.on(EVENTS.WORKFLOW.END, (/** @type {any} */ e) => ends.push(e));
    // The child executor is built inside the step engine; wrapping execute is the
    // only way to see the child's own run envelope (it emits on itself).
    const ownExecute = WorkflowExecutor.prototype.execute;
    /** @type {any} */
    (WorkflowExecutor.prototype).execute = async function patched(/** @type {any} */ args) {
        this.on(EVENTS.WORKFLOW.START, (/** @type {any} */ e) => starts.push(e));
        return ownExecute.call(this, args);
    };
    try {
        await executor.execute({ userGoal: 'goal' });
    } finally {
        /** @type {any} */
        (WorkflowExecutor.prototype).execute = ownExecute;
    }

    assert.equal(starts.filter((e) => e.nestedIn === undefined).length, 2,
        'the parent run and the nested run both started');
    const parentStart = starts.find((e) => e.nestedIn === undefined);
    const childStart = starts.find((e) => e.nestedIn === undefined && e.runId !== parentStart?.runId);
    const outerStepStart = stepStarts.find((e) => e.stepId === 'outer');
    assert.ok(parentStart && childStart, 'both runs started');
    assert.ok(outerStepStart, 'the nested-DAG node has a step context');
    assert.notEqual(childStart.runId, parentStart.runId, 'the nested run has its own run id');
    assert.equal(childStart.parentRunId, outerStepStart.runId, 'the nested run is parented to the step that started it');
    assert.equal(childStart.sessionId, 'sess-1', 'the nested run inherits the session');

    // W4-4: the child's start/end are forwarded too, and every forwarded event
    // names the child run explicitly — the re-stamp keeps payload fields.
    const forwardedStart = starts.find((e) => e.nestedIn === 'outer');
    assert.ok(forwardedStart, 'the nested run start is re-emitted on the parent');
    assert.equal(forwardedStart.nestedRunId, childStart.runId, 'the forwarded start names the child run id');
    const forwardedEnd = ends.find((e) => e.nestedIn === 'outer');
    assert.ok(forwardedEnd, 'the nested run end is re-emitted on the parent');
    assert.equal(forwardedEnd.nestedRunId, childStart.runId, 'the forwarded end names the child run id');

    const innerStart = stepStarts.find((e) => e.stepId === 'inner');
    assert.ok(innerStart, 'the inner step start is re-emitted on the parent');
    assert.equal(innerStart.nestedIn, 'outer', 'the forwarded event names the node that owns the nested run');
    assert.equal(innerStart.nestedRunId, childStart.runId, 'the inner step names its own run, not only its owning node');
});

// ─── R3: nested child state is checkpointed (no re-run of completed steps) ──

test('R3: a resumed nested-DAG step restores completed child steps instead of re-running them', async () => {
    
    /** @type {string[]} */
        const seen = [];
    const client = makeFakeClient({ runImpl: async (input) => {
        const text = userText({ input });
        seen.push(text);
        return text.includes('do x2') ? 'leaf-x2' : `echo:${text.slice(0, 16)}`;
    } });
    const subSteps = [
        { id: 'x1', userPromptTemplate: 'do x1', dependencies: [] },
        { id: 'x2', userPromptTemplate: 'do x2', dependencies: ['x1'] },
    ];

    const child = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 0 } });
    child.setSteps({ stepsList: subSteps });
    await child.execute({ userGoal: 'subgoal' });
    const childState = child.save();
    const afterChild = seen.length;

    const parent = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 0 } });
    parent.setSteps({ stepsList: [{ ...SIMPLE_STEP, engine: 'dag', subSteps }] });
    const state = JSON.parse(parent.save());
    Object.assign(state.steps[0], { status: 'running', _childState: childState });

    const resumed = WorkflowExecutor.load({ json: JSON.stringify(state), options: { client, defaultModel: 'm', maxReplanCount: 0 } });
    await resumed.execute({ userGoal: 'goal' });

    assert.equal(seen.length, afterChild, 'the resumed child must not re-run its completed steps');
    assert.equal(resumed.outputs['outer'].output, 'leaf-x2', 'the restored child leaf is the parent step output');
});
