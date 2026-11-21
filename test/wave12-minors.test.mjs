// @ts-check

/**
 * Wave 12 — the three findings that were still scheduled after wave 11.
 *
 * D7 — a checkpoint rehydrates the context tail but drops its `parent` chain.
 * D6 — the executor hands the SAME mutable `AgentContext` to every sibling step.
 * D2 — `transfer` in `stringify` mode ignores `select`/`tail`/`compact` entirely.
 *
 * Check-first: written before the fixes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AgentContext } from '../lib/agentic/agent-context.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { renderTransfer, normalizeTransfer } from '../lib/agentic/transfer.mjs';

// ─── D7: the delegation chain survives a checkpoint ───

test('D7/chain: a rehydrated context keeps its ancestors, not just its own values', () => {
    const root = new AgentContext({ objective: 'root objective' });
    const child = root.child({ directive: 'child directive' });
    const grand = child.child({ objective: 'grand objective' });
    // What a checkpoint writes: the live object, JSON-serialised.
    const json = JSON.parse(JSON.stringify(grand));

    const back = AgentContext.fromJSON(json);
    assert.equal(back?.objective, 'grand objective');
    assert.equal(back?.parent?.directive, 'child directive', 'the parent is restored');
    assert.equal(back?.parent?.parent?.objective, 'root objective', 'and the grandparent');
    assert.equal(back?.parent?.parent?.parent, null, 'the chain ends where it ended live');
    // The restored chain is usable, not just present: a delegation from it grows the chain.
    const great = back?.child({ objective: 'great' });
    assert.equal(great?.parent?.parent?.parent?.objective, 'root objective');
});

test('D7/depth: the chain is capped at exactly 32 nodes, the tail included', () => {
    /** @param {number} n */
    const chainOf = (n) => {
        /** @type {any} */
        let node = { objective: 'o0' };
        for (let i = 1; i < n; i++) node = { objective: `o${i}`, parent: node };
        return node;
    };
    /** @param {any} ctx */
    const depthOf = (ctx) => {
        let depth = 0;
        for (/** @type {any} */ let c = ctx; c; c = c.parent) depth += 1;
        return depth;
    };
    assert.equal(depthOf(AgentContext.fromJSON(chainOf(31))), 31, 'a 31-node chain is restored whole');
    assert.equal(depthOf(AgentContext.fromJSON(chainOf(32))), 32, 'a 32-node chain is the limit');
    assert.equal(depthOf(AgentContext.fromJSON(chainOf(33))), 32, '33 is cut to 32');
    assert.equal(depthOf(AgentContext.fromJSON(chainOf(500))), 32, 'and a pathological one too');
    assert.equal(AgentContext.fromJSON(chainOf(500))?.objective, 'o499', 'the tail is the one restored');
});

test('D7/pin: a context with no parent restores exactly as before', () => {
    const ctx = new AgentContext({ objective: 'solo', refs: { a: 1 } });
    const back = AgentContext.fromJSON(JSON.parse(JSON.stringify(ctx)));
    assert.equal(back?.objective, 'solo');
    assert.deepEqual(back?.refs, { a: 1 });
    assert.equal(back?.parent, null);
    assert.equal(AgentContext.fromJSON(null), null, 'a missing context still restores to null');
});

// ─── D6: sibling steps do not share one mutable context ───

test('D6/snapshot: a step view is a deep copy of the payload and keeps the lineage', () => {
    const ctx = new AgentContext({ objective: 'goal', refs: { a: { b: 1 } }, metadata: { m: { n: 2 } } });
    const view = ctx.snapshot();
    assert.equal(view.objective, 'goal');
    assert.equal(view.parent, ctx, 'the view still points at the context it came from');
    const viewRefs = /** @type {Record<string, any>} */ (view.refs);
    const viewMeta = /** @type {Record<string, any>} */ (view.metadata);
    const ctxRefs = /** @type {Record<string, any>} */ (ctx.refs);
    const ctxMeta = /** @type {Record<string, any>} */ (ctx.metadata);
    viewRefs.a.b = 99;
    viewMeta.m.n = 99;
    viewRefs.extra = true;
    assert.equal(ctxRefs.a.b, 1, 'a nested ref mutation does not reach the run context');
    assert.equal(ctxMeta.m.n, 2, 'nor a metadata mutation');
    assert.equal('extra' in ctxRefs, false, 'nor a new key');
    // The objective policy is view-local too: a step that edits it cannot retune the run.
    ctx.objectivePolicy = { adaptable: true, updateTurns: 3 };
    const view2 = ctx.snapshot();
    /** @type {any} */ (view2.objectivePolicy).updateTurns = 99;
    assert.equal(ctx.objectivePolicy?.updateTurns, 3, 'the policy is copied, not shared');
});

/** A stub that records the context each step was handed and mutates it. */
function makeStubClient() {
    /** @type {Array<{marker: string, ctx: any, text: string}>} */
    const seen = [];
    const client = /** @type {any} */ (new EventEmitter());
    client.session = () => ({
        provider: 'openai',
        _system: '',
        /** @type {any} */
        _agentContext: null,
        /** @param {any} m */
        withSystemMessage(m) { this._system = String(m ?? ''); return this; },
        withTools() { return this; },
        withMemory() { return this; },
        withTodos() { return this; },
        withParameters() { return this; },
        withCircuitBreaker() { return this; },
        /** @param {{initialInput: any}} arg0 */
        async run({ initialInput }) {
            const text = JSON.stringify(initialInput ?? '');
            const marker = ['A', 'B', 'C', 'D'].find((m) => text.includes(`Do ${m}.`)) ?? '?';
            // The objective pass runs its own session; only the steps matter here.
            if (marker === '?') return 'RESTATED OBJECTIVE';
            seen.push({ marker, ctx: this._agentContext, text });
            if (this._agentContext) {
                this._agentContext.refs = { ...(this._agentContext.refs ?? {}), [marker]: true };
            }
            return `answer ${marker}`;
        },
    });
    return { client, seen };
}

test('D6/siblings: two parallel steps get their own context object', async () => {
    const { client, seen } = makeStubClient();
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [
        { id: 'a', title: 'A', systemPrompt: 'sys-a', userPromptTemplate: 'Do A.', dependencies: [] },
        { id: 'b', title: 'B', systemPrompt: 'sys-b', userPromptTemplate: 'Do B.', dependencies: [] },
    ] });
    await executor.execute({ userGoal: 'GOAL', planner: null, evaluator: null, context: {} });

    assert.equal(seen.length, 2, 'both steps ran');
    const [a, b] = seen;
    assert.ok(a.ctx && b.ctx, 'each step was handed a context');
    assert.notEqual(a.ctx, b.ctx, 'not the same object');
    assert.equal(a.ctx.refs.A, true, "A's own mutation landed on A's view");
    assert.equal('A' in b.ctx.refs, false, "B does not see A's mutation");
    assert.equal('B' in a.ctx.refs, false, "A does not see B's mutation");
    assert.deepEqual(/** @type {any} */ (executor)._agentContext.refs, {}, 'the run context stays clean');
    // The objective pass may restate before either step, but both views must agree
    // with each other and with the run context (only the payload is isolated).
    assert.equal(a.ctx.objective, b.ctx.objective, 'both views see the same objective');
    assert.equal(a.ctx.objective, /** @type {any} */ (executor)._agentContext.objective, 'and it is the run objective');
});

test('D6/absorb: a restatement a step makes on its view reaches the run context', async () => {
    const { runStep } = await import('../lib/agentic/step.mjs');
    const runCtx = new AgentContext({ objective: 'GOAL' });
    const view = runCtx.snapshot();
    const client = /** @type {any} */ (new EventEmitter());
    client.session = () => ({
        provider: 'openai',
        _agentContext: null,
        withSystemMessage() { return this; },
        withTools() { return this; },
        withRetryPolicy() { return this; },
        withHeaderTimeout() { return this; },
        withMaxElapsedMs() { return this; },
        withCircuitBreaker() { return this; },
        async run() {
            // What an in-session objective pass does: it writes to the view.
            view.objective = 'RESTATED BY A';
            view.objectiveVersion = 1;
            return 'answer';
        },
    });
    await runStep({ step: { name: 'a', model: 'm' }, deps: {
        client, session: client.session(), model: 'm', configureSession: false,
        agentContext: view, messages: [{ role: 'user', content: 'go' }], maxIterations: 1,
    } });
    assert.equal(runCtx.objective, 'RESTATED BY A', 'the run context adopted the restatement');
    assert.equal(runCtx.objectiveVersion, 1);

    // A stale view cannot roll it back, and neither can one with the same version.
    const stale = new AgentContext({ objective: 'GOAL' }).snapshot();
    assert.equal(runCtx.absorbObjective({ from: stale }), false, 'an older version is ignored');
    assert.equal(runCtx.objective, 'RESTATED BY A');
    const sameVersion = runCtx.snapshot();
    sameVersion.objective = 'A LATER EDIT WITHOUT A VERSION BUMP';
    assert.equal(runCtx.absorbObjective({ from: sameVersion }), false, 'the version is the contract');
    assert.equal(runCtx.objective, 'RESTATED BY A');
});

test('D6/absorb-diverge: a stale view that restated twice cannot overwrite a newer one', () => {
    const runCtx = new AgentContext({ objective: 'GOAL', objectiveVersion: 0 });
    // Sibling A prepared first, restated twice: GOAL -> A1 -> A2 (version 2).
    const stale = runCtx.snapshot();
    stale.objectiveHistory.push('GOAL');
    stale.objective = 'A1'; stale.objectiveVersion = 1;
    stale.objectiveHistory.push('A1');
    stale.objective = 'A2'; stale.objectiveVersion = 2;
    // Sibling B restated once from the same base and was adopted first.
    const fresh = new AgentContext({ objective: 'GOAL', objectiveVersion: 0 });
    fresh.objectiveHistory.push('GOAL');
    fresh.objective = 'B1'; fresh.objectiveVersion = 1;
    assert.equal(runCtx.absorbObjective({ from: fresh }), true, 'B is adopted');
    assert.equal(runCtx.absorbObjective({ from: stale }), false, "A's higher-but-diverged version is not");
    assert.equal(runCtx.objective, 'B1');
});

test('D6/deep-copy: a Map in refs is copied, and a value the clone cannot take is not lost', () => {
    const fn = () => 'kept by reference';
    const ctx = new AgentContext({ objective: 'g', refs: { map: new Map([['k', 'v']]), fn } });
    const view = ctx.snapshot();
    const viewRefs = /** @type {Record<string, any>} */ (view.refs);
    const ctxRefs = /** @type {Record<string, any>} */ (ctx.refs);
    assert.ok(viewRefs.map instanceof Map, 'the Map stays a Map');
    assert.equal(viewRefs.map.get('k'), 'v', 'with its entries');
    assert.notEqual(viewRefs.map, ctxRefs.map, 'and it is a copy');
    assert.equal(typeof viewRefs.fn, 'function', 'a function is kept, not dropped');
    viewRefs.map.set('k', 'changed');
    assert.equal(ctxRefs.map.get('k'), 'v', 'mutating the copy leaves the source alone');
});

test('D7/checkpoints: the executor and state-machine checkpoints carry the chain too', async () => {
    const { TaskState } = await import('../lib/agentic/planning/task-state.mjs');
    const root = new AgentContext({ objective: 'root' });
    const child = root.child({ directive: 'child' });
    const saved = new TaskState({ objective: 'root', agentContext: child });
    const restored = new TaskState(saved.toJSON());
    assert.equal(restored.agentContext?.parent?.objective, 'root', 'TaskState keeps the parent');

    // The in-memory round trip (`new TaskState(saved.toJSON())`) is capped and does
    // not alias the live chain.
    /** @type {any} */
    let deep = new AgentContext({ objective: 'd0' });
    for (let i = 1; i < 40; i++) deep = /** @type {any} */ (deep.child({ objective: `d${i}` }));
    const capped = new TaskState(new TaskState({ objective: 'd39', agentContext: deep }).toJSON());
    let depth = 0;
    for (let c = /** @type {any} */ (capped.agentContext); c; c = c.parent) depth += 1;
    assert.ok(depth <= 32, `an in-memory restore is capped (depth ${depth})`);
    assert.notEqual(capped.agentContext?.parent, deep.parent, 'and the parent is a copy, not the live object');

    const { StateMachine } = await import('../lib/agentic/state-machine/machine.mjs');
    /** @type {any} */
    const graph = { entry: 'n1', edges: [], nodes: [{ id: 'n1', execute: () => 'ok' }] };
    const sm = new StateMachine({ graph, options: { agentContext: child, client: /** @type {any} */ (new EventEmitter()) } });
    const savedJson = JSON.parse(sm.save());
    assert.equal(savedJson.agentContext?.parent?.objective, 'root', 'the SM checkpoint writes the parent');
    // And it survives a load: a restatement after the resume starts from the chain.
    const back = StateMachine.load({ json: JSON.stringify(savedJson), graph });
    const resaved = JSON.parse(back.save());
    assert.equal(resaved.agentContext?.parent?.objective, 'root', 'and load restores it');
});

test('D6/sm: the state-machine engine also hands each step its own view', async () => {
    const { client, seen } = makeStubClient();
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', engine: 'stateMachine' } });
    executor.setSteps({ stepsList: [
        { id: 'a', title: 'A', systemPrompt: 'sys-a', userPromptTemplate: 'Do A.', dependencies: [] },
        { id: 'b', title: 'B', systemPrompt: 'sys-b', userPromptTemplate: 'Do B.', dependencies: [] },
    ] });
    await executor.execute({ userGoal: 'GOAL', planner: null, evaluator: null, context: {}, objectiveOptions: { adaptable: false } });
    assert.equal(seen.length, 2, 'both steps ran');
    assert.notEqual(seen[0].ctx, seen[1].ctx, 'not the same object');
    assert.notEqual(seen[0].ctx, /** @type {any} */ (executor)._agentContext, 'and not the run object');
    assert.equal('A' in seen[1].ctx.refs, false, "B does not see A's mutation");
});

// ─── D2: stringify mode honours the window ───

/** @param {string[]} ids */
const unitsOf = (ids) => ids.map((id) => ({ id, data: `body-${id}` }));

test('D2/stringify-window: select/tail windows the text in stringify mode', async () => {
    const out = await renderTransfer({
        units: unitsOf(['u1', 'u2', 'u3']),
        transfer: { mode: 'stringify', select: 'tail', tail: 1 },
    });
    assert.ok(out.text.includes('body-u3'), 'the tail unit is there');
    assert.equal(out.text.includes('body-u1'), false, 'the dropped unit is not');
    assert.equal(out.text.includes('body-u2'), false);
    assert.equal(out.dropped, 2, 'and the count says how many were dropped');
});

test('D2/stringify-compact: a dropped unit is summarized, or visibly marked without a summarizer', async () => {
    const withSummary = await renderTransfer({
        units: unitsOf(['u1', 'u2', 'u3']),
        transfer: { mode: 'stringify', select: 'tail', tail: 1, compact: true },
        summarize: () => 'THE EARLIER OUTPUTS, IN SHORT',
    });
    assert.ok(withSummary.text.includes('THE EARLIER OUTPUTS, IN SHORT'), 'the summary is in the text');
    assert.equal(withSummary.summarized, true);
    assert.ok(withSummary.text.indexOf('THE EARLIER OUTPUTS, IN SHORT') < withSummary.text.indexOf('body-u3'),
        'and it sits before the kept unit');

    const withoutSummary = await renderTransfer({
        units: unitsOf(['u1', 'u2', 'u3']),
        transfer: { mode: 'stringify', select: 'tail', tail: 1, compact: true },
    });
    assert.match(withoutSummary.text, /2 earlier entries omitted/, 'the drop is visible, never silent');
    assert.equal(withoutSummary.summarized, false);
});

test('D2/summarizer-throw: a failing summarizer degrades to the marker, it does not escape', async () => {
    const out = await renderTransfer({
        units: unitsOf(['u1', 'u2', 'u3']),
        transfer: { mode: 'stringify', select: 'tail', tail: 1, compact: true },
        summarize: () => { throw new Error('summarizer boom'); },
    });
    assert.match(out.text, /2 earlier entries omitted/, 'the drop is still visible');
    assert.equal(out.summarized, false);

    const ledger = await renderTransfer({
        units: unitsOf(['u1', 'u2', 'u3']).map((u) => ({ ...u, messages: [{ role: 'user', content: u.data }] })),
        transfer: { mode: 'ledger', select: 'tail', tail: 1, compact: true },
        targetProvider: 'openai',
        summarize: () => { throw new Error('summarizer boom'); },
    });
    assert.ok(Array.isArray(ledger.rows) && ledger.rows.length > 0, 'the ledger still renders');
    assert.equal(ledger.summarized, false);
    assert.match(JSON.stringify(ledger.rows), /earlier entries omitted/);
});

test('D2/dag-intake: the DAG stringify intake honours the transfer window', async () => {
    const { client, seen } = makeStubClient();
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [
        { id: 'a', title: 'A', userPromptTemplate: 'Do A.', dependencies: [] },
        { id: 'b', title: 'B', userPromptTemplate: 'Do B.', dependencies: [] },
        { id: 'c', title: 'C', userPromptTemplate: 'Do C.', dependencies: [] },
        { id: 'd', title: 'D', userPromptTemplate: 'Do D.', dependencies: ['a', 'b', 'c'], transfer: { mode: 'stringify', select: 'tail', tail: 1 } },
    ] });
    await executor.execute({ userGoal: 'GOAL', planner: null, evaluator: null, context: {}, objectiveOptions: { adaptable: false } });
    const d = seen.find((/** @type {any} */ s) => s.marker === 'D');
    assert.ok(d, 'step D ran');
    assert.equal(d.text.includes('answer C'), true, 'the last upstream step is in the prompt');
    assert.equal(d.text.includes('answer A'), false, 'the windowed-out one is not');
    assert.match(d.text, /2 earlier upstream steps omitted/, 'and the drop is visible');
});

test('D2/intake-moderated: an explicit tail still wins over the moderated default', async () => {
    const { client, seen } = makeStubClient();
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [
        { id: 'a', title: 'A', userPromptTemplate: 'Do A.', dependencies: [] },
        { id: 'b', title: 'B', userPromptTemplate: 'Do B.', dependencies: [] },
        { id: 'c', title: 'C', userPromptTemplate: 'Do C.', dependencies: [] },
        { id: 'd', title: 'D', userPromptTemplate: 'Do D.', dependencies: ['a', 'b', 'c'],
            handoff: { context: 'moderated' }, transfer: { mode: 'stringify', select: 'tail', tail: 1 } },
    ] });
    await executor.execute({ userGoal: 'GOAL', planner: null, evaluator: null, context: {}, objectiveOptions: { adaptable: false } });
    const d = seen.find((/** @type {any} */ s) => s.marker === 'D');
    assert.ok(d, 'step D ran');
    assert.equal(d.text.includes('answer C'), true, 'the tail is honoured');
    assert.equal(d.text.includes('answer A'), false, 'not the moderated default of 8');
    assert.equal(d.text.includes('answer B'), false);
});

test('D2/pin: a default stringify transfer is unchanged', async () => {
    const out = await renderTransfer({ units: unitsOf(['u1', 'u2', 'u3']) });
    assert.equal(out.dropped, 0);
    assert.equal(out.summarized, false);
    for (const id of ['u1', 'u2', 'u3']) assert.ok(out.text.includes(`body-${id}`), `${id} is there`);
    assert.equal(normalizeTransfer({ transfer: null }).mode, 'stringify');
});
