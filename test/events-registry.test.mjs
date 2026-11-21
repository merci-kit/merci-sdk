// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EVENTS, RunContext, stampEvent, stampStreamEvent, emitEvent, runWithRunContext } from '../lib/core/events.mjs';
import { runAgenticLoop, drainStepWithHooks, stepAgentic } from '../lib/agentic/agentic-core.mjs';
import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { AbstractChatSession } from '../lib/agentic/chat-session.mjs';
import { executeTools } from '../lib/tools/tool-execution.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';
import { AbortedError } from '../lib/core/errors.mjs';

// ── EVENTS registry ─────────────────────────────────────────────────────────

test('EVENTS: every value is a non-empty, unique, dot/colon-namespaced string', () => {
    const seen = new Set();
    /** @param {{node: *}} arg0 */
    const walk =  (/** @type {(...args: any[]) => any} */ (({ node }) => {
        for (const v of Object.values(node)) {
            if (typeof v === 'string') {
                assert.ok(v.length > 0, 'event name must be non-empty');
                assert.ok(/^[\w:.-]+$/.test(v), `event name "${v}" has an odd character`);
                assert.ok(!seen.has(v), `duplicate event name "${v}"`);
                seen.add(v);
            } else if (v && typeof v === 'object') {
                walk({ node: v });
            }
        }
    }));
    walk({ node: EVENTS });
    assert.ok(seen.size > 80, 'registry should cover the full surface');
    assert.equal(Object.isFrozen(EVENTS), true);
    assert.equal(Object.isFrozen(EVENTS.CLIENT), true);
});

test('EVENTS: canonical names match the emitted strings', () => {
    assert.equal(EVENTS.CLIENT.RUN_START, 'run:start');
    assert.equal(EVENTS.CLIENT.ABORTED, 'aborted');
    assert.equal(EVENTS.CLIENT.TOKEN_REFRESH_FAILURE, 'token_refresh_failure');
    assert.equal(EVENTS.MEMORY.DISTILL_ERROR, 'memory:distill_error');
    assert.equal(EVENTS.TOOL.CALL_START, 'tool:call_start');
    assert.equal(EVENTS.SHELL.APPROVAL_REQUESTED, 'shell:approval_requested');
    assert.equal(EVENTS.WORKFLOW.END, 'workflow:end');
    assert.equal(EVENTS.STATE_MACHINE.NODE_THOUGHT_SIGNATURE, 'state_machine:node_thought_signature');
    assert.equal(EVENTS.DISCUSSION.LEDGER_ENTRY, 'discussion:ledger_entry');
    assert.equal(EVENTS.DISCUSSION.LEDGER_PRUNED, 'discussion:ledger_pruned');
});

test('EVENTS: every registry entry is referenced by the library (no dead names)', () => {
    const libDir = join(import.meta.dirname, '..', 'lib');
    /** @type {any[]} */
    const files =  ([]);
    const walk =  (/** @type {(...args: any[]) => any} */ ((dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (entry.name.endsWith('.mjs') && p !== join(libDir, 'core', 'events.mjs')) files.push(p);
        }
    }));
    walk(libDir);
    const all = files.map(f => readFileSync(f, 'utf8')).join('\n');
    /** @type {any[]} */
    const dead =  ([]);
    /** @param {{node: *, path: *}} arg0 */
    const walkEvents =  (/** @type {(...args: any[]) => any} */ (({ node, path }) => {
        for (const [key, v] of Object.entries(node)) {
            const seg = [...path, key].join('.');
            if (typeof v === 'string') {
                const literal = `'${v}'`;
                const referenced = all.includes(key) && key !== v.toUpperCase()
                    ? all.includes(key)
                    : all.includes(key) || all.includes(literal);
                if (!all.includes(literal) && !all.includes(seg.split('.').pop() ?? '')) {
                    dead.push(seg);
                }
            } else {
                walkEvents({ node: v, path: [...path, key] });
            }
        }
    }));
    walkEvents({ node: EVENTS, path: [] });
    assert.deepEqual(dead, [], 'every EVENTS name must be referenced somewhere in lib/');
});

// ── SDKEvent envelope ────────────────────────────────────────────────────────

test('stampEvent: builds the envelope and preserves the payload', () => {
    const e =  (stampEvent({ name: EVENTS.CLIENT.TOOL_START, payload: { calls: [1, 2] } }));
    assert.equal(e.event, EVENTS.CLIENT.TOOL_START);
    assert.deepEqual(e.calls, [1, 2]);
    assert.equal(typeof e.ts, 'number');
    assert.equal(e.runId, null);
    assert.equal(e.parentRunId, null);
});

test('stampEvent: envelope fields win over payload collisions', () => {
    const e =  (stampEvent({ name: 'x', payload: { event: 'evil', ts: 'evil' } }));
    assert.equal(e.event, 'x');
    assert.equal(typeof e.ts, 'number');
});

test('stampStreamEvent: keeps the { type } contract and adds correlation', () => {
    const ctx = new RunContext();
    const raw = { type: 'text', content: 'hi' };
    const stamped =  (stampStreamEvent({ event: raw, runContext: ctx }));
    assert.equal(stamped.type, 'text');
    assert.equal(stamped.content, 'hi');
    assert.equal(stamped.runId, ctx.runId);
    assert.equal(typeof stamped.ts, 'number');
    assert.equal(stampStreamEvent({ event: /** @type {any} */ (null), runContext: ctx }), null);
});

// ── RunContext correlation ───────────────────────────────────────────────────

test('RunContext: minted runId, child inherits parentRunId', () => {
    const root = new RunContext();
    const child = RunContext.child(root);
    assert.notEqual(child.runId, root.runId);
    assert.equal(child.parentRunId, root.runId);
    const orphan = RunContext.child(null);
    assert.equal(orphan.parentRunId, null);
});

test('RunContext.emit: stamps and emits on an EventEmitter; null emitter is a no-op', () => {
    const emitter = new EventEmitter();
    const ctx = new RunContext();
    let captured =  (null);
    emitter.on(EVENTS.CLIENT.RUN_END, (e) => { captured = e; });
    ctx.emit({ emitter, name: EVENTS.CLIENT.RUN_END, payload: { finishReason: 'stop' } });
    assert.equal(/** @type {any} */ (captured).event, EVENTS.CLIENT.RUN_END);
    assert.equal(/** @type {any} */ (captured).runId, ctx.runId);
    assert.equal(/** @type {any} */ (captured).finishReason, 'stop');
    assert.doesNotThrow(() => ctx.emit({ emitter: null, name: 'x', payload: {} }));
});

// ── runAgenticLoop lifecycle emission ────────────────────────────────────────


/** @param {{replies: *}} arg0 */
function emitterSession({ replies }) {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const seen =  ([]);
    let n = 0;
    return {
        provider: ProviderType.OPENAI,
        model: 'm',
        _tools: [],
        eventEmitter: emitter,
        seen,
        /** @param {{messages: *, options: *}} arg0 */
        async *step({ messages, options }) {
            seen.push({ messages, options });
            const content = replies[Math.min(n++, replies.length - 1)];
            return { done: true, content, messages: [...messages, { role: 'assistant', content }] };
        }
    };
}

test('run:start/run:end fire around a run with matching runId', async () => {
    const s = emitterSession({ replies: ['hi'] });
    /** @type {any[]} */
    const events =  ([]);
    s.eventEmitter.on(EVENTS.CLIENT.RUN_START, (e) => events.push(e));
    s.eventEmitter.on(EVENTS.CLIENT.RUN_END, (e) => events.push(e));
    await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }] });
    assert.equal(events.length, 2);
    assert.equal(events[0].event, EVENTS.CLIENT.RUN_START);
    assert.equal(events[0].provider, 'openai');
    assert.equal(events[1].event, EVENTS.CLIENT.RUN_END);
    assert.equal(events[0].runId, events[1].runId, 'start/end share the run id');
    assert.equal(events[1].finishReason, 'stop');
    assert.equal(events[1].steps, 1);
    assert.equal(typeof events[1].durationMs, 'number');
});

test('onEvent stream events gain runId/ts and keep type', async () => {
    const s = emitterSession({ replies: ['hi'] });
    /** @type {any[]} */
    const stream =  ([]);
    await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }], opts: {
        onEvent:  (/** @type {(...args: any[]) => any} */ ((e) => stream.push(e)))
    } });
    const ends = stream.filter(e => e.type === 'stream_end');
    assert.equal(ends.length, 1);
    assert.equal(typeof ends[0].runId, 'string');
    assert.equal(typeof ends[0].ts, 'number');
});

test('run:end carries the full usage breakdown and an honest finishReason', async () => {
    const emitter = new EventEmitter();
    const s = {
        provider: ProviderType.OPENAI,
        model: 'm',
        _tools: [],
        eventEmitter: emitter,
        async *step() {
            yield { type: 'quota', data: { prompt_tokens: 100, completion_tokens: 40, cache_creation_input_tokens: 5, cache_read_input_tokens: 10, reasoning_tokens: 3 } };
            return { done: true, content: 'hi', messages: [{ role: 'assistant', content: 'hi' }] };
        }
    };
    /** @type {any[]} */
    const ends =  ([]);
    emitter.on(EVENTS.CLIENT.RUN_END, (e) => ends.push(e));
    await runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }] });
    assert.equal(ends.length, 1);
    assert.deepEqual(ends[0].usage, {
        prompt_tokens: 100, completion_tokens: 40, total_tokens: 140,
        cache_creation_input_tokens: 5, cache_read_input_tokens: 10, reasoning_tokens: 3,
        // The model has no price entry, so the cost is unknown — never zero.
        cost_usd: null,
        // B-9: one call spent tokens with no price, so the sum is a lower bound.
        cost_unreported_calls: 1
    });
    assert.equal(ends[0].finishReason, 'stop');
});

test('mid-stream vendor errors reach the onEvent stream (never silent)', async () => {
    const emitter = new EventEmitter();
    const s = {
        provider: ProviderType.OPENAI,
        model: 'm',
        _tools: [],
        eventEmitter: emitter,
        async *step() {
            yield { type: 'error', error_message: 'content filter', error_type: 'safety' };
            return { done: true, content: 'partial', messages: [{ role: 'assistant', content: 'partial' }], streamError: { type: 'error', error_message: 'content filter', error_type: 'safety' } };
        }
    };
    /** @type {any[]} */
    const stream =  ([]);
    /** @type {any[]} */
    const ends =  ([]);
    emitter.on(EVENTS.CLIENT.RUN_END, (e) => ends.push(e));
    // B-5: the stream error is thrown (so the retry policy sees it), never
    // resolved as an answer.
    await assert.rejects(() => runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }], opts: { onEvent:  (/** @type {(...args: any[]) => any} */ ((e) => stream.push(e))) } }), /content filter/);
    const err =  (stream.find(e => e.type === 'error'));
    assert.equal(err.error_message, 'content filter');
    assert.equal(typeof err.runId, 'string', 'stamped like every stream event');
    assert.equal(ends[0].finishReason, 'error', 'run:end reflects the stream error');
});

test('aborted fires with the reason when the run is cancelled', async () => {
    const ac = new AbortController();
    ac.abort(new Error('user cancel'));
    const s = emitterSession({ replies: ['hi'] });
    /** @type {any[]} */
    const aborted =  ([]);
    s.eventEmitter.on(EVENTS.CLIENT.ABORTED, (e) => aborted.push(e));
    await assert.rejects(
        runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }], opts: { signal: ac.signal } }),
        AbortedError
    );
    assert.equal(aborted.length, 1);
    assert.equal(aborted[0].event, EVENTS.CLIENT.ABORTED);
    assert.match(aborted[0].reason, /Agentic loop aborted|user cancel/);
});

test('error:thrown fires for a non-abort run failure', async () => {
    const s = {
        provider: ProviderType.OPENAI,
        model: 'm',
        _tools: [],
        eventEmitter: new EventEmitter(),
        async *step() { throw new Error('vendor exploded'); }
    };
    /** @type {any[]} */
    const thrown =  ([]);
    s.eventEmitter.on(EVENTS.ERRORS.THROWN, (e) => thrown.push(e));
    await assert.rejects(runAgenticLoop({ session: s, messages: [{ role: 'user', content: 'go' }] }), /vendor exploded/);
    assert.equal(thrown.length, 1);
    assert.equal(thrown[0].name, 'Error');
    assert.match(thrown[0].message, /vendor exploded/);
});

test('tool round: drainStepWithHooks emits tool:call_start/end + round bounds', async () => {
    const emitter = new EventEmitter();
    const ctx = new RunContext();
    /** @type {any[]} */
    const events =  ([]);
    for (const name of [
        EVENTS.TOOL.ROUND_START, EVENTS.TOOL.CALL_START, EVENTS.TOOL.CALL_END, EVENTS.TOOL.ROUND_END
    ]) {
        emitter.on(name, (e) => events.push(e));
    }
    const tools = [{
        name: 'echo',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'pong'
    }];
    
    /** @returns {AsyncGenerator<any, any, any>} */
    async function* gen() {
        yield { type: 'tool_request', calls: [{ id: 'c1', name: 'echo', args: '{}' }] };
        const results = /** @type {any} */ (yield);
        return { done: false, messages: [{ role: 'assistant', tool_calls: [] }] };
    }
    await drainStepWithHooks({ gen: gen(), tools, emitter, runContext: ctx });
    const kinds = events.map(e => e.event);
    assert.deepEqual(kinds, [
        EVENTS.TOOL.ROUND_START, EVENTS.TOOL.CALL_START, EVENTS.TOOL.CALL_END, EVENTS.TOOL.ROUND_END
    ]);
    assert.equal(events[1].id, 'c1');
    assert.equal(events[1].name, 'echo');
    assert.equal(events[2].success, true);
    assert.equal(typeof events[2].durationMs, 'number');
    assert.equal(events[0].runId, ctx.runId);
});

// ── WorkflowExecutor step correlation + terminal details ─────────────────────


/** @param {{runImpl: *}} arg0 */
function fakeClient({ runImpl }) {
    return {
        session: () => ({
            provider: 'openai',
            withSystemMessage() { return this; },
            withTools() { return this; },
            withMemory() { return this; },
            withTodos() { return this; },
            withParameters() { return this; },
            run: runImpl,
        })
    };
}

test('workflow: each step carries a child runId; step_complete has durationMs', async () => {
    const client = fakeClient({ runImpl: async () => 'ok' });
    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    /** @type {any[]} */
    const events =  ([]);
    exec.on(EVENTS.WORKFLOW.START, (e) => events.push(['start', e]));
    exec.on(EVENTS.WORKFLOW.STEP_START, (e) => events.push(['step_start', e]));
    exec.on(EVENTS.WORKFLOW.STEP_COMPLETE, (e) => events.push(['step_complete', e]));
    exec.on(EVENTS.WORKFLOW.END, (e) => events.push(['end', e]));
    exec.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'x', userPromptTemplate: 'do it', dependencies: [] }] });
    await exec.execute({ userGoal: 'goal' });

    const start = events.find(([k]) => k === 'start')[1];
    const stepStart = events.find(([k]) => k === 'step_start')[1];
    const stepComplete = events.find(([k]) => k === 'step_complete')[1];
    const end = events.find(([k]) => k === 'end')[1];

    assert.equal(stepStart.parentRunId, start.runId, 'step is a child of the workflow run');
    assert.notEqual(stepStart.runId, start.runId, 'step has its own runId');
    assert.equal(stepComplete.runId, stepStart.runId, 'start/complete share the step runId');
    assert.equal(stepComplete.stepId, 'a');
    assert.equal(typeof stepComplete.durationMs, 'number', 'step_complete carries durationMs');
    assert.equal(end.stepsCompleted, 1);
    assert.equal(end.stepsFailed, 0);
    assert.equal(typeof end.durationMs, 'number');
});

test('workflow: naive and SM engines emit the shared verify base shape', async () => {
    const naive = new WorkflowExecutor({ options: {
        client: fakeClient({ runImpl: async () => 'good' }),
        defaultModel: 'm'
    } });
    /** @type {any[]} */
    const seen =  ([]);
    naive.on(EVENTS.WORKFLOW.STEP_VERIFY_FAIL, (e) => seen.push(e));
    naive.setSteps({ stepsList: [{
        id: 'a', title: 'A', systemPrompt: 'x', userPromptTemplate: 'do it', dependencies: [],
        maxRetries: 1,
        verify:  (/** @type {(...args: any[]) => any} */ (async (out) => ({ passed: false, evidence: 'nope' })))
    }] });
    await naive.execute({ userGoal: 'goal' }).catch(() => {});
    assert.equal(seen.length, 1);
    assert.equal(typeof seen[0].attempt, 'number');
    assert.equal(typeof seen[0].evidence, 'string');

    const sm = new WorkflowExecutor({ options: {
        client: fakeClient({ runImpl: async () => 'good' }),
        defaultModel: 'm',
        engine: 'stateMachine',
        contract: { maxRetries: 0, criteria: [{ name: 'c', check: () => ({ passed: false, evidence: 'x' }) }] }
    } });
    /** @type {any[]} */
    const smSeen =  ([]);
    sm.on(EVENTS.WORKFLOW.STEP_VERIFY_FAIL, (e) => smSeen.push(e));
    sm.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'x', userPromptTemplate: 'do it', dependencies: [] }] });
    await sm.execute({ userGoal: 'goal' }).catch(() => {});
    assert.equal(smSeen.length, 1);
    assert.equal(typeof smSeen[0].attempt, 'number', 'SM verify_fail carries the base attempt key');
    assert.equal(typeof smSeen[0].evidence, 'string');
    assert.equal(typeof smSeen[0].classification, 'string', 'SM extras preserved');
});

test('discussion: verify-gated turns surface verify decisions on the discussion emitter', async () => {
    const client = {
        session: () => ({
            provider: 'openai',
            withSystemMessage() { return this; },
            withTools() { return this; },
            withParameters() { return this; },
            run: async () => 'turn output',
        })
    };
    const group = new DiscussionSession({ client });
    /** @type {any[]} */
    const seen =  ([]);
    group.on(EVENTS.DISCUSSION.VERIFY_FAIL, (e) => seen.push(e));
    group.on(EVENTS.DISCUSSION.VERIFY_RETRY, (e) => seen.push(e));
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });
    await group.runTasks({ tasks: [{
        title: 't',
        description: 'd',
        assignee: 'A',
        maxRetries: 2,
        verify: () => ({ passed: false, evidence: 'bad' })
    }] });
    assert.equal(seen.some(e => e.event === EVENTS.DISCUSSION.VERIFY_FAIL), true, 'verify_fail surfaced');
    assert.equal(seen.some(e => e.event === EVENTS.DISCUSSION.VERIFY_RETRY), true, 'verify_retry surfaced');
    assert.equal(seen[0].agent, 'A');
    assert.equal(typeof seen[0].evidence, 'string');
});

// ── HITL gates: serializable approvalId contract ─────────────────────────────


/** @param {{runImpl: *}} arg0 */
function hitlClient({ runImpl }) {
    return {
        session: () => ({
            provider: 'openai',
            withSystemMessage() { return this; },
            withTools() { return this; },
            withMemory() { return this; },
            withTodos() { return this; },
            withParameters() { return this; },
            run: runImpl,
        })
    };
}

test('HITL: hitl_pending carries { approvalId, timeoutMs } — never the live coordinator', async () => {
    const client = hitlClient({ runImpl: async () => 'ok' });
    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm', hitlTimeoutMs: 5000 } });
    let payload = /** @type {any} */ (null);
    exec.on(EVENTS.WORKFLOW.HITL_PENDING, (e) => { payload = e; exec.resolveApproval({ approvalId: e.approvalId, approved: true }); });
    exec.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'x', userPromptTemplate: 'do it', dependencies: [], hitl: true }] });
    const outputs = await exec.execute({ userGoal: 'goal' });
    assert.equal(( (/** @type {any} */ (outputs))).a.output, 'ok', 'approved gate lets the step complete');
    assert.equal(/** @type {any} */ (payload).stepId, 'a');
    assert.match(/** @type {any} */ (payload).approvalId, /^approval_\d+$/, 'serializable approval id');
    assert.equal(/** @type {any} */ (payload).timeoutMs, 5000);
    assert.ok(!('coordinator' in payload), 'no live ApprovalCoordinator in the payload');
    assert.equal(typeof /** @type {any} */ (payload).systemPrompt, 'string');
    assert.equal(typeof /** @type {any} */ (payload).userPrompt, 'string');
});

test('HITL: a declined gate fails the step and is never replanned', async () => {
    const client = hitlClient({ runImpl: async () => 'unreachable' });
    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxReplanCount: 3 } });
    exec.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'x', userPromptTemplate: 'do it', dependencies: [], hitl: true }] });
    let replans = 0;
    const replan = async () => { replans++; return { steps: [{ id: 'a', title: 'A', systemPrompt: 'x', userPromptTemplate: 'retry', dependencies: [] }] }; };
    exec.on(EVENTS.WORKFLOW.HITL_PENDING, ({ approvalId }) => exec.resolveApproval({ approvalId, approved: false }));
    await assert.rejects(() => exec.execute({ userGoal: 'goal', planner: { replan }, evaluator: null }), /rejected by the human operator/);
    assert.equal(replans, 0, 'operator rejection must not engage the in-loop replan');
    assert.equal(( (/** @type {any} */ (exec.steps.get('a')))).status, 'failed');
});

test('HITL: resolveApproval on an unknown/settled id returns false (idempotent)', async () => {
    const client = hitlClient({ runImpl: async () => 'ok' });
    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm', hitlTimeoutMs: 5000 } });
    assert.equal(exec.resolveApproval({ approvalId: 'approval_999', approved: true }), false, 'unknown id');
    let gateId = null;
    exec.on(EVENTS.WORKFLOW.HITL_PENDING, ({ approvalId }) => {
        gateId = approvalId;
        exec.resolveApproval({ approvalId, approved: true });
    });
    exec.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'x', userPromptTemplate: 'do it', dependencies: [], hitl: true }] });
    await exec.execute({ userGoal: 'goal' });
    assert.ok(gateId, 'gate opened');
    assert.equal(exec.resolveApproval({ approvalId: gateId, approved: false }), false, 'settled gate is gone (late click ignored)');
});

test('HITL: a missing or non-boolean decision is refused, never defaulted to approve (C-4)', () => {
    const client = hitlClient({ runImpl: async () => 'ok' });
    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm', hitlTimeoutMs: 5000 } });
    assert.throws(() => exec.resolveApproval(/** @type {any} */ ({ approvalId: 'approval_1' })), /approved: boolean/);
    assert.throws(() => exec.resolveApproval({ approvalId: 'approval_1', approved: /** @type {any} */ ('false') }), /approved: boolean/);
});

test('HITL: iteration-limit gate resolves via approvalId and extends the run', async () => {
    /** @param {{options: *}} arg0 */
    const client = hitlClient({ runImpl: /** @type {(...args: any[]) => any} */ (async ({ options: opts }) => {
        const extended = await opts.onLimitReached({ reason: 'limit', iterationsUsed: 1, extensionRound: 0 });
        return extended ? 'extended answer' : 'fallback';
    }) });
    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm', maxIterations: 1 } });
    let payload = /** @type {any} */ (null);
    exec.on(EVENTS.WORKFLOW.HITL_ITERATION_LIMIT, (e) => { payload = e; exec.resolveApproval({ approvalId: e.approvalId, approved: true }); });
    exec.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'x', userPromptTemplate: 'do it', dependencies: [] }] });
    const outputs = await exec.execute({ userGoal: 'goal' });
    assert.equal(( (/** @type {any} */ (outputs))).a.output, 'extended answer', 'approved extension lets the loop continue');
    assert.match(/** @type {any} */ (payload).approvalId, /^approval_\d+$/);
    assert.ok(!('coordinator' in payload));
});

// ── Per-call correlation threading (no shared session state) ─────────────────

test('executeTools threads the runContext into tool.execute (3rd param)', async () => {
    const emitter = new EventEmitter();
    const ctx = new RunContext();
    let received =  (null);
    const tools = [{
        name: 'probe',
        parameters: { type: 'object', properties: {} },
        
        /** @param {{args: *, signal: *, context: *}} arg0 */
        execute: async ({ args, signal, context }) => { received = context; return 'ok'; }
    }];
    await executeTools({ toolCalls: [{ id: 'c1', name: 'probe', args: '{}' }], toolLibrary: tools, signal: null, emitter, runContext: ctx });
    assert.ok(received, 'tool.execute received the execution context');
    assert.equal(/** @type {any} */ (received).runContext, ctx);
});

test('interleaved step() loops on one session keep distinct runIds', async () => {
    const emitter = new EventEmitter();
    /** @type {any[]} */
    const events =  ([]);
    for (const name of [EVENTS.CLIENT.SESSION_STEP_START, EVENTS.CLIENT.API_REQUEST]) {
        emitter.on(name, (e) => events.push([name, e]));
    }
    const session = new (class extends AbstractChatSession {})({ provider: ProviderType.OPENAI, model: 'm', eventEmitter: emitter, client: {} });
    session._adapter = {
        vendorName: 'OAI',
        /** @param {{preparedMessages: *}} arg0 */
        buildVendorRequest:  (/** @type {(...args: any[]) => any} */ (({ preparedMessages }) => ({ request: {}, observability: { model: 'm', messages: preparedMessages } }))),
        async executeVendorRequest() {
            return (async function* () {
                yield { type: 'text', content: 'hi' };
            })();
        },
        
        /** @param {{rawStream: *}} arg0 */
        async *consumeStream({ rawStream: stream }) { for await (const e of stream) yield e; },
        extractXmlToolCalls: () => [],
        
        /** @param {{call: *}} arg0 */
        formatToolCall: ({ call: c }) => ({ id: c.id, name: c.name, args: '{}' }),
    };
    const ctx1 = new RunContext();
    const ctx2 = new RunContext();
    const gen1 = session.step({ messages: [{ role: 'user', content: 'one' }], options: { runContext: ctx1 } });
    const gen2 = session.step({ messages: [{ role: 'user', content: 'two' }], options: { runContext: ctx2 } });
    let r1 = await gen1.next();
    let r2 = await gen2.next();
    while (!r1.done || !r2.done) {
        if (!r1.done) r1 = await gen1.next(( (/** @type {any} */ (r1.value)))?.type === 'tool_request' ? [] : undefined);
        if (!r2.done) r2 = await gen2.next(( (/** @type {any} */ (r2.value)))?.type === 'tool_request' ? [] : undefined);
    }
    const stepStarts = events.filter(([k]) => k === EVENTS.CLIENT.SESSION_STEP_START).map(([, e]) => e);
    assert.equal(stepStarts.length, 2, 'two steps started');
    assert.notEqual(stepStarts[0].runId, stepStarts[1].runId, 'distinct step runIds');
    const parents = new Set(stepStarts.map(e => e.parentRunId));
    assert.deepEqual([...parents].sort(), [ctx1.runId, ctx2.runId].sort(), 'each step child of its own caller context');
    const requests = events.filter(([k]) => k === EVENTS.CLIENT.API_REQUEST).map(([, e]) => e);
    assert.equal(requests.length, 2);
    const requestParents = new Set(requests.map(e => e.parentRunId));
    assert.deepEqual([...requestParents].sort(), [ctx1.runId, ctx2.runId].sort(), 'telemetry follows its own step');
});

// ── AsyncLocalStorage correlation (Phase A) ──────────────────────────────────

test('stampEvent: resolves the ambient runContext installed by runWithRunContext', () => {
    const ctx = new RunContext({ sessionId: 'als-session' });
    const e = runWithRunContext({ runContext: ctx, fn: () => stampEvent({ name: EVENTS.CLIENT.WARNING, payload: { message: 'x' } }) });
    assert.equal(e.runId, ctx.runId);
    assert.equal(e.sessionId, 'als-session');
    assert.equal(e.event, EVENTS.CLIENT.WARNING);
    assert.equal(e.message, 'x');
});

test('emitEvent: stamps the ambient runContext and preserves the payload', () => {
    const emitter = new EventEmitter();
    const ctx = new RunContext();
    /** @type {any} */
    let captured = null;
    emitter.on('x:probe', (/** @type {any} */ e) => { captured = e; });
    runWithRunContext({ runContext: ctx, fn: () => emitEvent({ emitter, name: 'x:probe', payload: { a: 1 } }) });
    assert.equal(captured.runId, ctx.runId);
    assert.equal(captured.event, 'x:probe');
    assert.equal(captured.a, 1);
    assert.equal(typeof captured.ts, 'number');
});

test('ALS: a tool-leg emission with no explicit runContext inherits the run id', async () => {
    const emitter = new EventEmitter();
    const ctx = new RunContext({ sessionId: 'als-run' });
    const seen = /** @type {any[]} */ ([]);
    emitter.on('x:probe', (/** @type {any} */ e) => seen.push(e));
    const tools = [{
        name: 'probe',
        parameters: { type: 'object', properties: {} },
        execute: async () => { emitEvent({ emitter, name: 'x:probe', payload: { from: 'tool' } }); return 'ok'; }
    }];
    await runWithRunContext({ runContext: ctx, fn: () => executeTools({
        toolCalls: [{ id: 'c1', name: 'probe', args: '{}' }],
        toolLibrary: tools, emitter, runContext: null
    }) });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].runId, ctx.runId, 'component/tool emissions correlate without a threaded runContext');
    assert.equal(seen[0].from, 'tool');
});

test('emitEvent: a throwing listener never propagates; it surfaces as event:listener_error', () => {
    const emitter = new EventEmitter();
    const errors = /** @type {any[]} */ ([]);
    emitter.on('x:boom', () => { throw new Error('listener exploded'); });
    emitter.on(EVENTS.ERRORS.LISTENER_ERROR, (/** @type {any} */ e) => errors.push(e));
    assert.doesNotThrow(() => emitEvent({ emitter, name: 'x:boom', payload: {} }));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].sourceEvent, 'x:boom');
    assert.match(errors[0].error, /listener exploded/);
});

test('EVENTS.STEP registers every stream type the session consumes', () => {
    assert.equal(EVENTS.STEP.FIRST_TOKEN, 'first_token');
    assert.equal(EVENTS.STEP.REDACTED_THINKING, 'redacted_thinking');
    assert.equal(EVENTS.STEP.TOOL_CALL_DELTA, 'tool_call_delta');
    assert.equal(EVENTS.STEP.REASONING_ITEM, 'reasoning_item');
    assert.equal(EVENTS.STEP.THINKING_BLOCKS, 'thinking_blocks');
    assert.equal(EVENTS.STEP.THOUGHT_PARTS, 'thought_parts');
    assert.equal(EVENTS.STEP.FINISH, 'finish');
    assert.equal(EVENTS.STEP.PREMATURE_END, 'premature_end');
    assert.equal(EVENTS.STEP.RESTART, 'restart');
    assert.equal(EVENTS.STEP.UNKNOWN, 'unknown');
    // the mid-stream vendor error is the canonical 'error' (registry forbids duplicates)
    assert.equal(EVENTS.CLIENT.ERROR, 'error');
    assert.equal(EVENTS.STEP.ERROR, undefined);
    assert.equal(EVENTS.ERRORS.LISTENER_ERROR, 'event:listener_error');
});
