// @ts-check

/**
 * Wave 7 / PL2a — the session dial.
 *
 * One rule (`inherit | new | <group>`) over four presets. A group is one
 * conversation: one system prompt, one tool set, one growing history, one cache
 * prefix. A member that would change the prompt or the tools opens a boundary group
 * instead of silently corrupting the prefix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

/** @param {any} text @returns {string} */
function asText(text) {
    if (typeof text === 'string') return text;
    if (Array.isArray(text)) return text.map((m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? m))).join('\n');
    return JSON.stringify(text);
}

/**
 * A client that records every session it hands out and the input rows each run saw.
 * @param {{answer?: (text: string, n: number) => string|Promise<string>, onRun?: ((arg0: {last: string, full: string}) => void)|null}} [arg0]
 */
function makeClient({ answer = (/** @type {string} */ text) => 'OUT', onRun = /** @type {null|((arg0: {last: string, full: string}) => void)} */ (null) } = {}) {
    /** @type {any[]} */
    const sessions = [];
    const client = {
        sessions,
        getProfiles: async () => [{ id: 'm' }, { id: 'm1' }, { id: 'm2' }],
        session(/** @type {string} */ model) {
            const s = /** @type {any} */ ({
                provider: 'openai',
                model,
                system: null,
                inputs: /** @type {any[]} */ ([]),
                runs: 0,
                withSystemMessage(/** @type {string} */ msg) { s.system = msg; return s; },
                withTools() { return s; },
                withMemory() { return s; },
                withTodos() { return s; },
                withParameters() { return s; },
                withPromptCache() { return s; },
                run(/** @type {{initialInput: any}} */ { initialInput }) {
                    // The answer is chosen from the newest row, not the whole
                    // transcript: a shared conversation carries earlier steps' text.
                    const rows = Array.isArray(initialInput) ? initialInput : [initialInput];
                    const text = asText(rows.at(-1)?.content ?? initialInput);
                    onRun?.({ last: text, full: asText(initialInput) });
                    s.inputs.push(initialInput);
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
    systemPrompt: `Be terse (${id}).`,
    userPromptTemplate: `${id.toUpperCase()}-STEP`,
    dependencies,
    ...extra,
});

/** Builds an executor over a linear a→b→c plan. @param {any} client @param {Record<string, any>} [options] */
function linear(client, options = {}) {
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', ...options } });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a']), step('c', ['b'])] });
    return executor;
}

// ─── presets ───────────────────────────────────────────────────────────────

test('P2/session-step-default: the default is one session per step attempt', async () => {
    const client = makeClient();
    const executor = linear(client);
    assert.equal(executor.sessionScope, 'step', 'the default is step');
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.equal(client.sessions.length, 3, 'three steps, three sessions');
    assert.equal(executor.cacheGroups, 3);
});

test('P2/session-plan-one-group: a plan-level prompt makes the whole plan one conversation', async () => {
    const client = makeClient();
    const executor = linear(client, { sessionScope: 'plan', sessionSystemPrompt: 'You are the plan agent.' });
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.equal(client.sessions.length, 1, 'one session for the whole plan');
    assert.equal(executor.cacheGroups, 1, 'one cache prefix');
    assert.equal(client.sessions[0].system, 'You are the plan agent.', 'the group owns the prompt');

    // The second step sees the first step's exchange, plus its own focus.
    const second = asText(client.sessions[0].inputs[1]);
    assert.match(second, /A-STEP/, 'the first step stays in the conversation');
    assert.match(second, /\[Step focus\]/, "the node's own prompt becomes a step focus");
    assert.match(second, /B-STEP/, 'the node instruction is there too');
});

test('P2/session-plan-history: a completed step appends its rows to the group', async () => {
    const client = makeClient({ answer: (text) => (text.includes('A-STEP') ? 'A-RESULT' : 'B-RESULT') });
    const executor = linear(client, { sessionScope: 'plan', sessionSystemPrompt: 'stable' });
    const outputs = await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.equal(/** @type {any} */ (outputs).a.output, 'A-RESULT');
    const group = /** @type {any} */ (executor)._sessionGroups.get('__plan__');
    assert.ok(group, 'the plan group exists');
    assert.ok(group.completed.has('a') && group.completed.has('b') && group.completed.has('c'));
    const history = group.history.flatMap((/** @type {any} */ e) => e.rows).map((/** @type {any} */ r) => asText(r.content ?? r)).join('\n');
    assert.match(history, /A-RESULT/, 'the first answer is part of the shared history');
});

test('P2/session-branch: each branch root opens a group', async () => {
    const client = makeClient();
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'branch', sessionSystemPrompt: 'stable' } });
    // root fans out to two chains: root → left → leftEnd, root → right
    executor.setSteps({ stepsList: [
        step('root'),
        step('left', ['root']),
        step('leftEnd', ['left']),
        step('right', ['root']),
    ] });
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.equal(executor.cacheGroups, 1, 'the root opens the only branch scope');
    assert.equal(client.sessions.length, 1);
});

// ─── the per-node rule ─────────────────────────────────────────────────────

test('P2/session-node-new: a node annotation opens its own conversation even under plan scope', async () => {
    const client = makeClient();
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'plan', sessionSystemPrompt: 'stable' } });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a'], { session: 'new' }), step('c', ['b'])] });
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.equal(executor.cacheGroups, 2, 'the annotated node starts a second group');
    const planInputs = /** @type {any} */ (executor)._sessionGroups.get('__plan__').history;
    assert.equal(planInputs.length > 0, true, 'the plan group still has history');
    const own = /** @type {any} */ (executor)._sessionGroups.get('b');
    assert.ok(own, 'b opened its own group');
    assert.equal(own.history.flatMap((/** @type {any} */ e) => e.rows).some((/** @type {any} */ r) => asText(r.content ?? r).includes('A-STEP')), false, 'b did not inherit the plan history');
});

test('P2/session-group-join: two nodes can share a named group under the step default', async () => {
    const client = makeClient();
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [
        step('a', [], { session: 'pair', systemPrompt: 'Shared pair prompt.' }),
        step('b', ['a'], { session: 'pair', systemPrompt: 'Shared pair prompt.' }),
        step('c', ['b']),
    ] });
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.equal(executor.cacheGroups, 2, 'the pair plus c');
    assert.equal(client.sessions.length, 2);
    const pairGroup = /** @type {any} */ (executor)._sessionGroups.get('pair');
    assert.deepEqual([...pairGroup.members], ['a', 'b']);
});

test('P2/session-boundary: a node that changes the system prompt opens a boundary and says so', async () => {
    const client = makeClient();
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'plan' } });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    /** @type {any[]} */
    const boundaries = [];
    executor.on('workflow:session_boundary', (e) => boundaries.push(e));
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.equal(executor.cacheGroups, 2, 'b could not share the first prompt');
    assert.equal(boundaries.length, 1, 'the split is reported');
    assert.equal(boundaries[0].field, 'systemPrompt');
    assert.equal(boundaries[0].stepId, 'b');
});

test('P2/session-tools-boundary: a change in the tool set also opens a boundary', async () => {
    const client = makeClient();
    const toolA = { name: 'search', description: 's', parameters: { type: 'object', properties: {} } };
    const toolB = { name: 'fetch', description: 'f', parameters: { type: 'object', properties: {} } };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'plan', sessionSystemPrompt: 'stable' } });
    executor.setSteps({ stepsList: [
        step('a', [], { handoff: { tools: [toolA] } }),
        step('b', ['a'], { handoff: { tools: [toolB] } }),
    ] });
    /** @type {any[]} */
    const boundaries = [];
    executor.on('workflow:session_boundary', (e) => boundaries.push(e));
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.equal(boundaries[0]?.field, 'tools');
    assert.equal(executor.cacheGroups, 2);
});

// ─── attempts ──────────────────────────────────────────────────────────────

test('P2/session-step-retry: under the step default a retry gets a fresh session', async () => {
    let calls = 0;
    const client = makeClient({ answer: () => {
        calls += 1;
        return calls === 1 ? 'BAD' : 'A-OUT';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    executor.setSteps({ stepsList: [step('a', [], { verify: (/** @type {string} */ out) => ({ passed: out === 'A-OUT', evidence: 'not yet' }), maxRetries: 1 })] });
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.equal(client.sessions.length, 2, 'each attempt is isolated (the contract dag-engine pins)');
    assert.equal(executor.cacheGroups, 2);
});

test('P2/session-group-retry: a chosen group persists across a retry', async () => {
    let calls = 0;
    const client = makeClient({ answer: () => {
        calls += 1;
        return calls === 1 ? 'BAD' : 'A-OUT';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'plan', sessionSystemPrompt: 'stable' } });
    executor.setSteps({ stepsList: [step('a', [], { verify: (/** @type {string} */ out) => ({ passed: out === 'A-OUT', evidence: 'not yet' }), maxRetries: 1 })] });
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.equal(client.sessions.length, 1, 'the plan group spans the retry');
    assert.equal(executor.cacheGroups, 1);
});

test('P2/session-invalid-scope: an unknown preset is rejected at construction', () => {
    assert.throws(() => new WorkflowExecutor({ options: { client: makeClient(), sessionScope: /** @type {any} */ ('swarm') } }), /unknown sessionScope 'swarm'/);
});

test('P2/session-requeue: a rejected and requeued step does not leak its stale rows into a dependent', async () => {
    let aRuns = 0;
    let bRuns = 0;
    const client = makeClient({ answer: (text) => {
        if (text.includes('B-STEP')) {
            bRuns += 1;
            const seen = /OUT-A-\d/.exec(text)?.[0] ?? 'NONE';
            return `OUT-B-${bRuns}-sees-${seen}`;
        }
        aRuns += 1;
        return `OUT-A-${aRuns}`;
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'plan', sessionSystemPrompt: 'stable', maxReplanCount: 3 } });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    let aVerdicts = 0;
    /** @type {any} */
    const outputs = await executor.execute({
        userGoal: 'goal',
        objectiveOptions: { adaptable: false },
        planner: { replan: async () => ({ steps: [step('a'), step('b', ['a'])] }) },
        evaluator: { evaluate: async (/** @type {any} */ { node }) => {
            if (node.id !== 'a') return { replanRequired: false };
            aVerdicts += 1;
            return { replanRequired: aVerdicts === 1, reason: 'weak' };
        } },
    });
    assert.equal(aRuns, 2, 'a was requeued and re-run');
    // b had not run yet when a was rejected, so it runs once — against the new output.
    assert.equal(bRuns, 1, 'b ran once, after the replan');
    assert.match(String(outputs.b.output), /sees-OUT-A-2/, 'b saw the current upstream, not the stale one');
    assert.equal(String(outputs.b.output).includes('OUT-A-1'), false, 'the stale upstream row is gone');
    const group = /** @type {any} */ (executor)._sessionGroups.get('__plan__');
    const rows = group.history.flatMap((/** @type {any} */ e) => e.rows).map((/** @type {any} */ r) => asText(r.content ?? r)).join('\n');
    assert.equal(rows.includes('OUT-A-1'), false, 'the group history dropped the rejected answer');
    assert.equal(group.history.filter((/** @type {any} */ e) => e.stepId === 'a').length, 1, 'one entry per member');
});

// ─── verifier round: the contract had holes ───────────────────────────────

test('P2/session-model-boundary: a different model cannot ride a shared group', async () => {
    const client = makeClient();
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm1', sessionScope: 'plan', sessionSystemPrompt: 'stable' } });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a'], { model: 'm2' })] });
    /** @type {any[]} */
    const boundaries = [];
    executor.on('workflow:session_boundary', (e) => boundaries.push(e));
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.equal(boundaries[0]?.field, 'model');
    assert.equal(executor.cacheGroups, 2);
    assert.equal(client.sessions[1]?.model, 'm2', 'the boundary session uses the node model');
});

test('P2/session-rejected-not-shared: a rejected attempt never joins the conversation', async () => {
    const client = makeClient({ answer: () => 'ALWAYS-BAD' });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'plan', sessionSystemPrompt: 'stable' } });
    executor.setSteps({ stepsList: [step('a', [], {
        verify: () => ({ passed: false, evidence: 'nope' }),
        maxRetries: 0,
    })] });
    /** @type {any} */
    let error = null;
    try { await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } }); } catch (err) { error = err; }
    assert.ok(error, 'the step fails verification');
    const group = /** @type {any} */ (executor)._sessionGroups.get('__plan__');
    assert.equal(group.completed.size, 0, 'nothing was accepted');
    assert.equal(group.history.length, 0, 'the rejected rows were never recorded');
});

test('P2/session-ancestors-only: a shared group never leaks a sibling branch (C1)', async () => {
    /** @type {Record<string, string>} */
    const seen = {};
    const client = makeClient({ onRun: ({ last, full }) => {
        for (const id of ['a', 'b', 'c', 'e']) {
            if (last.includes(`${id.toUpperCase()}-STEP`)) seen[id] = full;
        }
    }, answer: (text) => {
        if (text.includes('B-STEP')) return 'B-ANSWER';
        if (text.includes('C-STEP')) return 'C-SECRET';
        if (text.includes('E-STEP')) return 'E-ANSWER';
        return 'A-ANSWER';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'plan', sessionSystemPrompt: 'stable', maxConcurrency: 3 } });
    executor.setSteps({ stepsList: [
        step('a'),
        step('b', ['a']),
        step('c', ['a']),
        step('e', ['b']),
    ] });
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.match(seen.e ?? '', /B-ANSWER/, 'the ancestor is visible');
    assert.equal((seen.e ?? '').includes('C-SECRET'), false, 'the sibling branch is not');
});

test('P2/session-plan-order: the inherited rows follow plan order, not completion order', async () => {
    /** @type {string} */
    let dInput = '';
    const client = makeClient({ onRun: ({ last, full }) => {
        if (last.includes('D-STEP')) dInput = full;
    }, answer: async (text) => {
        if (text.includes('B-STEP')) {
            await new Promise((resolve) => setTimeout(resolve, 15));
            return 'B-ANSWER';
        }
        if (text.includes('C-STEP')) return 'C-ANSWER';
        if (text.includes('D-STEP')) return 'D-ANSWER';
        return 'A-ANSWER';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'plan', sessionSystemPrompt: 'stable', maxConcurrency: 2 } });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])] });
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.ok(dInput, 'd ran');
    const bAt = dInput.indexOf('B-ANSWER');
    const cAt = dInput.indexOf('C-ANSWER');
    assert.ok(bAt > -1 && cAt > -1, 'both ancestors are present');
    assert.ok(bAt < cAt, 'the inherited rows follow plan order even when c finished first');
});

test('P2/session-tools-schema: the same tool name with a different schema is a boundary', async () => {
    const client = makeClient();
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'plan', sessionSystemPrompt: 'stable' } });
    const v1 = { name: 'search', description: 's', parameters: { type: 'object', properties: { q: { type: 'string' } } } };
    const v2 = { name: 'search', description: 's', parameters: { type: 'object', properties: { query: { type: 'string' } } } };
    executor.setSteps({ stepsList: [
        step('a', [], { handoff: { tools: [v1] } }),
        step('b', ['a'], { handoff: { tools: [v2] } }),
    ] });
    /** @type {any[]} */
    const boundaries = [];
    executor.on('workflow:session_boundary', (e) => boundaries.push(e));
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.equal(boundaries[0]?.field, 'tools');
});

test('P2/session-history-cap: the inherited conversation is capped, oldest rows dropped', async () => {
    const client = makeClient({ answer: (text) => {
        if (text.includes('A-STEP')) return 'A-'.padEnd(400, 'a');
        if (text.includes('B-STEP')) return 'B-'.padEnd(400, 'b');
        return 'C-ANSWER';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'plan', sessionSystemPrompt: 'stable', sessionHistoryMaxChars: 700 } });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a']), step('c', ['b'])] });
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    const cInput = asText(client.sessions[0].inputs[2]);
    assert.match(cInput, /earlier row\(s\) omitted/, 'the budget is enforced visibly');
    assert.equal(cInput.includes('a'.repeat(300)), false, 'the oldest oversized row was dropped');
    assert.match(cInput, /b{300}/, 'the newest row survives');
});

test('P2/session-boundary-once: a retried boundary node reports the split once', async () => {
    let bAttempts = 0;
    const client = makeClient({ answer: (text) => {
        if (!text.includes('B-STEP')) return 'A-ANSWER';
        bAttempts += 1;
        return bAttempts === 1 ? 'BAD' : 'GOOD';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'plan' } });
    executor.setSteps({ stepsList: [
        step('a'),
        step('b', ['a'], { verify: (/** @type {string} */ out) => ({ passed: out === 'GOOD', evidence: 'again' }), maxRetries: 1 }),
    ] });
    /** @type {any[]} */
    const boundaries = [];
    executor.on('workflow:session_boundary', (e) => boundaries.push(e));
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.equal(bAttempts, 2, 'b was retried');
    assert.equal(boundaries.length, 1, 'one event per node and field');
});

// ─── round 2: the replay/drop path and the payload contract ────────────────

test('P2/session-historical-not-shared: a step dropped by a replan stops contributing rows', async () => {
    // The old scenario gave `c` a dependency on the rejected `b`, which is the C-2
    // bug (a dropped step still satisfying and feeding a dependent); `c` now hangs
    // off `a`, so this test keeps proving only what it is named for: the rows go.
    /** @type {Record<string, string>} */
    const seen = {};
    const client = makeClient({ onRun: ({ last, full }) => {
        for (const id of ['a', 'b', 'c']) if (last.includes(`${id.toUpperCase()}-STEP`)) seen[id] = full;
    }, answer: (text) => {
        if (text.includes('B-STEP')) return 'B-WEAK';
        if (text.includes('C-STEP')) return 'C-ANSWER';
        return 'A-ANSWER';
    } });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'plan', sessionSystemPrompt: 'stable', maxReplanCount: 3 } });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a']), step('c', ['a'])] });
    let verdicts = 0;
    await executor.execute({
        userGoal: 'goal',
        objectiveOptions: { adaptable: false },
        planner: { replan: async () => ({ steps: [step('a'), step('c', ['a'])] }) },
        evaluator: { evaluate: async (/** @type {any} */ { node }) => {
            if (node.id !== 'b') return { replanRequired: false };
            verdicts += 1;
            return { replanRequired: verdicts === 1, reason: 'weak' };
        } },
    });
    assert.equal(executor.steps.get('b')?.historical, true, 'b became history');
    assert.ok(seen.c, 'c ran');
    const group = /** @type {any} */ (executor)._sessionGroups.get('__plan__');
    assert.equal(group.history.some((/** @type {any} */ e) => e.stepId === 'b'), false, "the dropped step's exchange left the conversation");
});

test('P2/session-tools-description: a changed tool description is a boundary', async () => {
    const client = makeClient();
    const params = { type: 'object', properties: { q: { type: 'string' } } };
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'plan', sessionSystemPrompt: 'stable' } });
    executor.setSteps({ stepsList: [
        step('a', [], { handoff: { tools: [{ name: 'search', description: 'OLD DESC', parameters: params }] } }),
        step('b', ['a'], { handoff: { tools: [{ name: 'search', description: 'NEW DESC', parameters: params }] } }),
    ] });
    /** @type {any[]} */
    const boundaries = [];
    executor.on('workflow:session_boundary', (e) => boundaries.push(e));
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    assert.equal(boundaries[0]?.field, 'tools');
});

test('P2/session-history-cap-single: one oversized row is truncated, not carried whole', async () => {
    const huge = 'Z'.repeat(400);
    const client = makeClient({ answer: (text) => (text.includes('A-STEP') ? huge : 'B-ANSWER') });
    const executor = new WorkflowExecutor({ options: { client, defaultModel: 'm', sessionScope: 'plan', sessionSystemPrompt: 'stable', sessionHistoryMaxChars: 300 } });
    executor.setSteps({ stepsList: [step('a'), step('b', ['a'])] });
    await executor.execute({ userGoal: 'goal', objectiveOptions: { adaptable: false } });
    const bInput = asText(client.sessions[0].inputs[1]);
    const inherited = bInput.split('B-STEP')[0];
    assert.match(bInput, /oversized row\(s\) truncated|earlier row\(s\) omitted/, 'the cut is visible');
    assert.match(inherited, /\[truncated \d+ of 400 chars\]/, 'the truncation is explicit');
    assert.ok(inherited.length < 900, 'the inherited conversation stays inside the budget');
});
