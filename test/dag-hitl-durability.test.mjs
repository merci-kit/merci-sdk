// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

/**
 * @param {{runImpl?: (input: any, options?: any) => any}} arg0
 */
function makeClient({ runImpl = async () => 'ok' } = {}) {
    return {
        session: () => ({
            provider: 'openai',
            withSystemMessage() { return this; },
            withTools() { return this; },
            withMemory() { return this; },
            withTodos() { return this; },
            withParameters() { return this; },
            withObjective() { return this; },
            /** @param {{initialInput: *, options: *}} arg0 */
            run: ({ initialInput: input, options }) =>
                isObjectiveRestatePrompt({ input }) ? Promise.resolve('') : runImpl(input, options),
        }),
    };
}

/** @param {any} _input @param {any} options */
async function iterationRun(_input, options) {
    const extended = await options.onLimitReached({ reason: 'limit', iterationsUsed: 1, extensionRound: 0, maxExtensions: 3 });
    return extended ? 'extended' : 'fallback';
}

/**
 * A one-step workflow checkpoint with durable state injected onto the step.
 * The step is left `running` so `WorkflowExecutor.load` re-queues it.
 * @param {{step?: Record<string, any>, status?: string, [key: string]: any}} [opts]
 */
function checkpoint({ step = {}, status = 'running', ...nodeState } = {}) {
    const ex = new WorkflowExecutor({ options: { client: makeClient(), defaultModel: 'm' } });
    ex.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'SYS', userPromptTemplate: 'do the thing', dependencies: [], hitl: true, ...step }] });
    const state = JSON.parse(ex.save());
    Object.assign(state.steps[0], { status, ...nodeState });
    return JSON.stringify(state);
}

test('D16: a checkpoint mid-step-gate re-opens the SAME gate (id + prompts)', async () => {
    const json = checkpoint({
        _hitlGate: {
            approvalId: 'approval_7',
            gateEvent: EVENTS.WORKFLOW.HITL_PENDING,
            systemPrompt: 'SYS-FROM-DISK',
            userPrompt: 'USER-FROM-DISK',
            extensionRound: null,
        },
    });
    const ex = WorkflowExecutor.load({ json: json, options: { client: makeClient(), defaultModel: 'm', hitlTimeoutMs: 5_000 } });
    let payload = /** @type {any} */ (null);
    ex.on(EVENTS.WORKFLOW.HITL_PENDING, (/** @type {any} */ e) => { payload = e; ex.resolveApproval({ approvalId: e.approvalId, approved: true }); });
    const out = await ex.execute({ userGoal: 'goal' });

    assert.ok(payload, 'the resumed gate must re-open');
    assert.equal(payload.approvalId, 'approval_7', 'the restored approval id is reused');
    assert.equal(payload.systemPrompt, 'SYS-FROM-DISK', 'the persisted system prompt is reused');
    assert.equal(payload.userPrompt, 'USER-FROM-DISK', 'the persisted user prompt is reused');
    assert.equal((/** @type {any} */ (out)).a.output, 'ok');
});

test('D16: an approved decision recorded before the checkpoint is replayed, not re-asked', async () => {
    const json = checkpoint({ _hitlDecision: { approved: true, systemPrompt: null, userPrompt: null } });
    const ex = WorkflowExecutor.load({ json: json, options: { client: makeClient(), defaultModel: 'm', hitlTimeoutMs: 50 } });
    let opened = 0;
    ex.on(EVENTS.WORKFLOW.HITL_PENDING, () => { opened++; });
    assert.ok(JSON.parse(ex.save()).steps[0]._hitlDecision, 'the decision stays on disk after load');

    const out = await ex.execute({ userGoal: 'goal' });
    assert.equal(opened, 0, 'an already-approved gate must not be re-opened');
    assert.equal((/** @type {any} */ (out)).a.output, 'ok');
});

test('D16: the approval sequence is seeded past restored gate ids', () => {
    const json = checkpoint({
        _hitlGate: {
            approvalId: 'approval_7',
            gateEvent: EVENTS.WORKFLOW.HITL_PENDING,
            systemPrompt: 'x',
            userPrompt: 'y',
            extensionRound: null,
        },
    });
    const ex = WorkflowExecutor.load({ json: json, options: { client: makeClient(), defaultModel: 'm' } });
    assert.ok(ex._approvalSeq >= 8, `expected _approvalSeq >= 8, got ${ex._approvalSeq}`);
});

test('D16: setSteps(originalPlan) after load keeps the durable gate state', () => {
    const json = checkpoint({ _hitlDecision: { approved: true, systemPrompt: null, userPrompt: null } });
    const ex = WorkflowExecutor.load({ json: json, options: { client: makeClient(), defaultModel: 'm' } });
    ex.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'SYS', userPromptTemplate: 'do the thing', dependencies: [], hitl: true }] });
    assert.ok((/** @type {any} */ (ex.steps.get('a')))._hitlDecision, 'the decision survives the D6 reattach');
});

test('D16: a checkpoint mid-iteration-gate re-opens the SAME gate id', async () => {
    const json = checkpoint({
        step: { hitl: false },
        _hitlGate: {
            approvalId: 'approval_3',
            gateEvent: EVENTS.WORKFLOW.HITL_ITERATION_LIMIT,
            systemPrompt: null,
            userPrompt: null,
            extensionRound: 0,
        },
    });
    const ex = WorkflowExecutor.load({ json: json, options: { client: makeClient({ runImpl: iterationRun }), defaultModel: 'm', hitlTimeoutMs: 1_000 } });
    let payload = /** @type {any} */ (null);
    ex.on(EVENTS.WORKFLOW.HITL_ITERATION_LIMIT, (/** @type {any} */ e) => { payload = e; ex.resolveApproval({ approvalId: e.approvalId, approved: true }); });
    const out = await ex.execute({ userGoal: 'goal' });

    assert.ok(payload, 'the iteration gate must re-open');
    assert.equal(payload.approvalId, 'approval_3', 'the restored iteration approval id is reused');
    assert.equal((/** @type {any} */ (out)).a.output, 'extended');
});

test('D16: an iteration-limit decision recorded before the checkpoint is replayed', async () => {
    const json = checkpoint({ step: { hitl: false }, _iterDecisions: { 0: true } });
    const ex = WorkflowExecutor.load({ json: json, options: { client: makeClient({ runImpl: iterationRun }), defaultModel: 'm', hitlTimeoutMs: 1_000 } });
    let opened = 0;
    ex.on(EVENTS.WORKFLOW.HITL_ITERATION_LIMIT, (/** @type {any} */ e) => { opened++; ex.resolveApproval({ approvalId: e.approvalId, approved: true }); });
    assert.ok(JSON.parse(ex.save()).steps[0]._iterDecisions, 'the iteration decision stays on disk after load');
    const out = await ex.execute({ userGoal: 'goal' });

    assert.equal(opened, 0, 'a recorded iteration decision must not re-open the gate');
    assert.equal((/** @type {any} */ (out)).a.output, 'extended');
});

test('D16: a recorded iteration decision replays by order, not exact round', async () => {
    const json = checkpoint({ step: { hitl: false }, _iterDecisions: { 2: true } });
    const ex = WorkflowExecutor.load({ json: json, options: { client: makeClient({ runImpl: iterationRun }), defaultModel: 'm', hitlTimeoutMs: 1_000 } });
    let opened = 0;
    ex.on(EVENTS.WORKFLOW.HITL_ITERATION_LIMIT, (/** @type {any} */ e) => { opened++; ex.resolveApproval({ approvalId: e.approvalId, approved: true }); });
    const out = await ex.execute({ userGoal: 'goal' });

    assert.equal(opened, 0, 'the recorded decision replays even when the resumed model renumbers rounds');
    assert.equal((/** @type {any} */ (out)).a.output, 'extended');
});

test('D16: setSteps with a CHANGED definition resets the durable gate state', () => {
    const json = checkpoint({
        _hitlGate: { approvalId: 'approval_1', gateEvent: EVENTS.WORKFLOW.HITL_PENDING, systemPrompt: 'x', userPrompt: 'y', extensionRound: null },
        _hitlDecision: { approved: true, systemPrompt: null, userPrompt: null },
        _iterDecisions: { 0: true },
    });
    const ex = WorkflowExecutor.load({ json: json, options: { client: makeClient(), defaultModel: 'm' } });
    ex.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'CHANGED', userPromptTemplate: 'do the thing', dependencies: [], hitl: true }] });
    const node = /** @type {any} */ (ex.steps.get('a'));
    assert.equal(node._hitlGate, undefined, 'a changed step must not re-open a stale gate');
    assert.equal(node._hitlDecision, undefined, 'a changed step must not replay a stale decision');
    assert.equal(node._iterDecisions, undefined, 'a changed step must not replay stale iteration decisions');
});

test('C-4: the first decision wins and a duplicate decision returns false', async () => {
    const ex = new WorkflowExecutor({ options: { client: makeClient(), defaultModel: 'm' } });
    ex.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'SYS', userPromptTemplate: 'do the thing', dependencies: [], hitl: true }] });
    /** @type {boolean[]} */
    const returns = [];
    ex.on(EVENTS.WORKFLOW.HITL_PENDING, (/** @type {any} */ e) => {
        returns.push(ex.resolveApproval({ approvalId: e.approvalId, approved: true }));
        returns.push(ex.resolveApproval({ approvalId: e.approvalId, approved: false }));
    });
    const out = await ex.execute({ userGoal: 'goal' });

    assert.deepEqual(returns, [true, false], 'the first decision takes effect; a duplicate is refused');
    assert.equal(/** @type {any} */ (out).a.output, 'ok', 'the first decision (approve) still governs');
});
