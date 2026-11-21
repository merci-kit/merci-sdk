// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { FALLBACK_MESSAGE } from '../lib/core/constants/index.mjs';
import { withTaskAgents } from '../lib/agentic/task.mjs';

/**
 * @param {{sys: any, calls: any[], behavior?: any}} arg0
 * @returns {any}
 */
function makeSession({ sys, calls, behavior = {} }) {
    return {
        provider: 'openai',
        sys,
        appliedRetry: false,
        appliedTimeout: false,
        withSystemMessage(/** @type {any} */ m) { this.sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : m; return this; },
        withTools() { return this; },
        withTodos() { return this; },
        withParameters() { return this; },
        withRetryPolicy() { this.appliedRetry = true; return this; },
        withStreamTimeout() { this.appliedTimeout = true; return this; },
        /** @param {{initialInput: *, options: *}} arg0 */
        async run({ initialInput: input, options: opts }) {
            calls.push({ input, opts });
            // ponytail: real sessions stream — the fake fires a text delta when the
            if (opts?.onEvent) opts.onEvent({ type: 'text', content: `streamed:${this.sys ?? 'no-sys'}` });
            if (this.sys && this.sys.includes('DAG Workflow Planner')) {
                return JSON.stringify({
                    summary: 'plan',
                    steps: [
                        { id: 'gather', title: 'Gather', systemPrompt: 'Gather facts', userPromptTemplate: 'Gather for: {{context.topic}}', dependencies: [] },
                        { id: 'write', title: 'Write', systemPrompt: 'Write up', userPromptTemplate: 'Write using: {{gather.output}}', dependencies: ['gather'] }
                    ]
                });
            }
            if (this.sys && this.sys.includes('quality evaluator')) {
                const v = behavior.verdicts?.shift() ?? { passed: false, score: 0, reason: 'no verdict queued', revision: 'minor' };
                return JSON.stringify(v);
            }
            if (this.sys && this.sys.includes('synthesize diverse inputs')) return behavior.aggregateOutput ?? 'FINAL ANSWER';
            return `answer from ${this.sys ?? 'no-sys'}`;
        }
    };
}

/**
 * @param {{behavior?: any}} arg0
 * @returns {any}
 */
function makeClient({ behavior = {} } = {}) {
    /** @type {any[]} */
    const calls = [];
    /** @type {any[]} */
    const sessions = [];
    return {
        calls,
        sessions,
        behavior,
        session: (/** @type {any} */ model) => {
            const s = makeSession({ sys: model, calls, behavior });
            sessions.push(s);
            return s;
        },
    };
}

// ─── runTasks: verified stage (SM-gated turn) ───────────────────────────────

test('runTasks: a verify-gated task runs through a StateMachine turn', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'Analyst', persona: 'Analyze.', model: 'm', provider: 'openai' });

    await group.runTasks({ tasks: [{
        title: 'analyze',
        description: 'Analyze the data.',
        assignee: 'Analyst',
        verify: (/** @type {any} */ out) => ({ passed: out.includes('answer'), evidence: out })
    }] });

    /** @type {any} */ const ledger = group.getLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].author, 'Analyst');
    assert.match(ledger[0].content, /answer from/);
});

test('runTasks: a persistently failing verify marks the stage as an error entry', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'Analyst', persona: 'Analyze.', model: 'm', provider: 'openai' });

    await group.runTasks({ tasks: [{
        title: 'analyze',
        description: 'Analyze.',
        assignee: 'Analyst',
        maxRetries: 1,
        verify: () => ({ passed: false, evidence: 'nope' })
    }] });

    /** @type {any} */ const ledger = group.getLedger();
    assert.match(ledger[0].content, /\[error:/);
});

// ─── runTasks: subagent delegation ──────────────────────────────────────────

test('runTasks: subagent_type delegates the stage to a registered profile', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{
        name: 'worker',
        /** @param {{prompt: *}} arg0 */
        execute: async (/** @type {any} */ { prompt }) => `worker processed: ${prompt}`
    }] });
    const group = new DiscussionSession({ client });

    await group.runTasks({ tasks: [{
        title: 'delegate',
        description: 'Do the heavy lifting.',
        subagent_type: 'worker'
    }] });

    /** @type {any} */ const ledger = group.getLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].author, 'worker');
    assert.equal(ledger[0].content, 'worker processed: Do the heavy lifting.');
});

test('runTasks: unknown subagent_type reports an error entry, not a throw', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    await group.runTasks({ tasks: [{ title: 'x', description: 'y', subagent_type: 'ghost' }] });
    /** @type {any} */ const ledger = group.getLedger();
    assert.equal(ledger.length, 1, 'an error entry records the failed stage');
    assert.match(ledger[0].content, /No subagent profile "ghost"/);
});

// ─── planForEach: per-agent DAG on subagent contexts ────────────────────────

test('planForEach: each agent plans its own DAG and executes steps on fresh sessions', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'First person.', model: 'mA', provider: 'openai' });
    group.addAgent({ name: 'B', persona: 'Second person.', model: 'mB', provider: 'openai' });

    await group.planForEach({ instruction: 'Research the topic.', options: { context: { topic: 'lazy evaluation' } } });

    /** @type {any} */ const ledger = group.getLedger();
    const authors = ledger.map((/** @type {any} */ e) => e.author);
    assert.deepEqual(authors.sort(), ['A', 'A', 'B', 'B'], 'two planned steps per agent, each on its own subagent context');
    assert.match(ledger[1].content, /answer from/);
});

// ─── stream forwarding (the "silent subagent" fix) ───────────────────────────

test('runTasks: an LLM subagent stage forwards agent_text deltas', async () => {
    const client = makeClient();
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const group = new DiscussionSession({ client });
    /** @type {any[]} */ const textEvents = [];
    group.on('discussion:agent_text', (e) => textEvents.push(e));

    await group.runTasks({ tasks: [{ title: 'delegate', description: 'Do the work.', subagent_type: 'worker' }] });

    assert.equal(textEvents.length, 1, 'the subagent turn streamed one text delta');
    assert.equal(textEvents[0].agent, 'worker');
    assert.match(textEvents[0].content, /^streamed:/);
});

test('planForEach: subagent steps forward agent_text deltas', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'First.', model: 'mA', provider: 'openai' });
    /** @type {any[]} */ const textEvents = [];
    group.on('discussion:agent_text', (e) => textEvents.push(e));

    await group.planForEach({ instruction: 'Research.', options: { context: { topic: 'x' } } });

    assert.ok(textEvents.length >= 2, 'each planned step streamed a delta');
    assert.ok(textEvents.every(e => e.agent === 'A' && e.content.startsWith('streamed:')));
});

// ─── opt-in resilience policies ──────────────────────────────────────────────

test('DiscussionSession: retryPolicy/streamTimeoutPolicy reach subagent sessions', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client, options: {
        retryPolicy: /** @type {any} */ ({ kind: 'exp' }),
        streamTimeoutPolicy: /** @type {any} */ ({ kind: 'inactivity' }),
    } });
    group.addAgent({ name: 'A', persona: 'First.', model: 'mA', provider: 'openai' });

    await group.planForEach({ instruction: 'Research.', options: { context: { topic: 'x' } } });

    const last = client.sessions[client.sessions.length - 1];
    assert.equal(last.appliedRetry, true);
    assert.equal(last.appliedTimeout, true);
});

test('DiscussionSession: no policies configured leaves sessions untouched', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'First.', model: 'mA', provider: 'openai' });

    await group.planForEach({ instruction: 'Research.', options: { context: { topic: 'x' } } });

    const last = client.sessions[client.sessions.length - 1];
    assert.equal(last.appliedRetry, false);
    assert.equal(last.appliedTimeout, false);
});

test('planForEach: an agent fallbackModel degrades a transiently failing step', async () => {
    /** @type {string[]} */
    const sessionModels = [];
    const client = {
        session(/** @type {string} */ model) {
            sessionModels.push(model);
            /** @type {any} */
            const s = {
                provider: 'openai',
                withSystemMessage(/** @type {any} */ m) { this.sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : m; return this; },
                withTools() { return this; },
                withParameters() { return this; },
                /** @param {{initialInput: *}} arg0 */
                async run({ initialInput: input }) {
                    const text = typeof input === 'string' ? input : String(input[0]?.content ?? '');
                    if (this.sys && this.sys.includes('DAG Workflow Planner')) {
                        return JSON.stringify({
                            summary: 'plan',
                            steps: [
                                { id: 'gather', title: 'Gather', systemPrompt: 'Gather facts', userPromptTemplate: 'Gather.', dependencies: [] },
                                { id: 'write', title: 'Write', systemPrompt: 'Write up', userPromptTemplate: 'Write using: {{gather.output}}', dependencies: ['gather'] }
                            ]
                        });
                    }
                    if (model === 'mA') {
                        const err = /** @type {Error & {code?: string}} */ (new Error('read ECONNRESET'));
                        err.code = 'ECONNRESET';
                        throw err;
                    }
                    return `fallback answer for: ${text.split('\n')[0].trim()}`;
                }
            };
            return s;
        }
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', fallbackModel: 'm-fallback', provider: 'openai' });
    /** @type {any[]} */
    const fallbacks = [];
    group.on('task:fallback', (e) => fallbacks.push(e));

    await group.planForEach({ instruction: 'Research.' });

    assert.ok(sessionModels.includes('m-fallback'), 'the fallback model got a fresh session');
    assert.equal(fallbacks.length, 2, 'both planned steps degraded');
    assert.ok(fallbacks.every((e) => e.subagent_type === 'A'));
    /** @type {any} */ const ledger = group.getLedger();
    assert.equal(ledger.length, 2);
    assert.match(String(ledger[0]?.content), /fallback answer/);
});

test('runTasks: an assignee stage degrades to the agent fallbackModel on a transient failure', async () => {
    /** @type {string[]} */
    const sessionModels = [];
    const client = {
        session(/** @type {string} */ model) {
            sessionModels.push(model);
            /** @type {any} */
            const s = {
                provider: 'openai',
                withSystemMessage(/** @type {any} */ m) { this.sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : m; return this; },
                withTools() { return this; },
                withParameters() { return this; },
                withRetryPolicy() { return this; },
                withStreamTimeout() { return this; },
                withCircuitBreaker() { return this; },
                /** @param {{initialInput: *}} arg0 */
                async run({ initialInput: input }) {
                    const text = typeof input === 'string' ? input : String(input[0]?.content ?? '');
                    if (model === 'mA') {
                        const err = /** @type {Error & {code?: string}} */ (new Error('read ECONNRESET'));
                        err.code = 'ECONNRESET';
                        throw err;
                    }
                    return `fallback answer for: ${text.split('\n')[0].trim()}`;
                }
            };
            return s;
        }
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', fallbackModel: 'm-fallback', provider: 'openai' });
    /** @type {any[]} */
    const fallbacks = [];
    group.on('task:fallback', (e) => fallbacks.push(e));

    await group.runTasks({ tasks: [{ title: 'compose', description: 'Compose the answer.', assignee: 'A' }] });

    assert.ok(sessionModels.includes('m-fallback'), 'the fallback model got a fresh session');
    assert.equal(fallbacks.length, 1, 'one degrade was reported');
    assert.equal(fallbacks[0].subagent_type, 'A');
    /** @type {any} */ const ledger = group.getLedger();
    assert.equal(ledger.length, 1);
    assert.match(String(ledger[0]?.content), /fallback answer/);
});

test('runTasks: an assignee stage degrades to fallbackModel on an empty-output result', async () => {
    const client = {
        session(/** @type {string} */ model) {
            /** @type {any} */
            const s = {
                provider: 'openai',
                withSystemMessage() { return this; },
                withTools() { return this; },
                withParameters() { return this; },
                withRetryPolicy() { return this; },
                withStreamTimeout() { return this; },
                withCircuitBreaker() { return this; },
                async run() {
                    return model === 'mA' ? FALLBACK_MESSAGE.EMPTY_RESPONSE : 'fallback answer';
                }
            };
            return s;
        }
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', fallbackModel: 'm-fallback', provider: 'openai' });
    /** @type {any[]} */
    const fallbacks = [];
    group.on('task:fallback', (e) => fallbacks.push(e));

    await group.runTasks({ tasks: [{ title: 'compose', description: 'Compose.', assignee: 'A' }] });

    assert.equal(fallbacks.length, 1, 'the empty output degraded to the fallback model');
    assert.equal(fallbacks[0].reason, 'empty-output');
    /** @type {any} */ const ledger = group.getLedger();
    assert.match(String(ledger[0]?.content), /fallback answer/);
});

// ─── tail + asVerdict ───────────────────────────────────────────────────────

test('judge: asVerdict parses the verdict; tail caps the ledger window', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });
    group.appendLedger({ entries: Array.from({ length: 5 }, (_, i) => ({ author: 'A', content: `entry ${i}`, type: 'discussion', thoughtSignature: null })) });

    /** @type {any} */ const verdict = await group.judge({ instruction: 'grade it', options: { asVerdict: true, tail: 3 } });

    const lastCall = client.calls[client.calls.length - 1];
    assert.equal(lastCall.input.length, 5, '1 loss marker + 3 ledger entries + 1 instruction');
    const contents = lastCall.input.map((/** @type {any} */ m) => m.content).join('\n');
    assert.ok(contents.includes('Earlier discussion entries omitted'), 'the dropped prefix is marked, never silent');
    assert.ok(contents.includes('entry 4'));
    assert.ok(!contents.includes('entry 0'), 'older entries are excluded by tail');
    assert.equal(verdict.passed, false, 'unparseable judge output is treated as not-passed');
});

test('aggregate: tail caps the ledger window', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });
    group.appendLedger({ entries: Array.from({ length: 4 }, (_, i) => ({ author: 'A', content: `entry ${i}`, type: 'discussion', thoughtSignature: null })) });

    await group.aggregate({ instruction: 'sum it', options: { tail: 2 } });

    const lastCall = client.calls[client.calls.length - 1];
    assert.equal(lastCall.input.length, 4, '1 loss marker + 2 ledger entries + 1 instruction');
});

// ─── replan: minor + full ───────────────────────────────────────────────────

test('replan: minor mode runs one revision turn per agent', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });

    await group.replan({ instruction: 'fix this', mode: 'minor' });

    /** @type {any} */ const ledger = group.getLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].type, 'revision');
    assert.equal(ledger[0].content, 'answer from p');
});

test('replan: full mode re-runs planForEach for every agent', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'First.', model: 'mA', provider: 'openai' });
    group.addAgent({ name: 'B', persona: 'Second.', model: 'mB', provider: 'openai' });

    await group.replan({ instruction: 'rebuild everything', mode: 'full' });

    /** @type {any} */ const ledger = group.getLedger();
    const authors = ledger.map((/** @type {any} */ e) => e.author);
    assert.deepEqual(authors.sort(), ['A', 'A', 'B', 'B'], 'full replan = one DAG per agent');
});

// ─── conclude: the branched pipeline ────────────────────────────────────────

test('conclude: judge accepts on the first pass → no replan, final aggregate returned', async () => {
    const client = makeClient({ behavior: { verdicts: [{ passed: true, score: 80, reason: 'strong', revision: 'minor' }] } });
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });

    /** @type {any[]} */ const judged = [];
    /** @type {any[]} */ const replans = [];
    group.on('discussion:judged', (e) => judged.push(e));
    group.on('discussion:replan', (e) => replans.push(e));

    /** @type {any} */ const final = await group.conclude({ instruction: 'topic', options: { judge: { minScore: 50 } } });

    assert.equal(replans.length, 0, 'no replan when the verdict passes');
    assert.equal(judged.length, 1, 'one initial judgement');
    assert.equal(judged[0].passed, true);
    assert.equal(final.content, 'FINAL ANSWER');
});

test('conclude: minor verdict → revision turns then rediscuss, then aggregate', async () => {
    const client = makeClient({ behavior: {
        verdicts: [
            { passed: false, score: 40, reason: 'weak', revision: 'minor' },
            { passed: true, score: 75, reason: 'better', revision: 'minor' }
        ]
    } });
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });

    /** @type {any[]} */ const replans = [];
    group.on('discussion:replan', (e) => replans.push(e));

    /** @type {any} */ const final = await group.conclude({ instruction: 'topic', options: { maxRounds: 2, judge: { minScore: 50 } } });

    assert.deepEqual(replans.map(({ mode, round }) => ({ mode, round })), [{ mode: 'minor', round: 1 }], 'one minor replan');
    const types = group.getLedger().map((/** @type {any} */ e) => e.type);
    assert.ok(types.includes('revision'), 'revision turns ran');
    assert.ok(types.includes('discussion'), 'rediscuss ran after the replan');
    assert.equal(final.content, 'FINAL ANSWER');
});

test('conclude: full verdict → re-runs planForEach, then rediscuss, then aggregate', async () => {
    const client = makeClient({ behavior: {
        verdicts: [
            { passed: false, score: 30, reason: 'drift', revision: 'full' },
            { passed: true, score: 85, reason: 'ok', revision: 'minor' }
        ]
    } });
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'First.', model: 'mA', provider: 'openai' });

    /** @type {any[]} */ const replans = [];
    group.on('discussion:replan', (e) => replans.push(e));

    /** @type {any} */ const final = await group.conclude({ instruction: 'topic', options: { maxRounds: 2, judge: { minScore: 50 } } });

    assert.deepEqual(replans.map(({ mode, round }) => ({ mode, round })), [{ mode: 'full', round: 1 }], 'one full replan');
    const types = group.getLedger().map((/** @type {any} */ e) => e.type);
    assert.ok(types.includes('task'), 'full replan re-ran per-agent DAG steps');
    assert.equal(final.content, 'FINAL ANSWER');
});

test('conclude: verdict never passes → capped by maxRounds, still aggregates', async () => {
    const client = makeClient({ behavior: {
        verdicts: [
            { passed: false, score: 20, reason: 'bad', revision: 'minor' },
            { passed: false, score: 30, reason: 'bad', revision: 'minor' },
            { passed: false, score: 40, reason: 'bad', revision: 'minor' }
        ]
    } });
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });

    /** @type {any[]} */ const judged = [];
    group.on('discussion:judged', (e) => judged.push(e));

    /** @type {any} */ const final = await group.conclude({ instruction: 'topic', options: { maxRounds: 2, judge: { minScore: 50 } } });

    assert.equal(judged.length, 3, 'initial + 2 replan rounds');
    assert.equal(judged[2].passed, false);
    assert.equal(final.content, 'FINAL ANSWER', 'aggregate still produces a conclusion');
    assert.equal(final.accepted, false, 'a rejected debate must surface accepted:false');
    assert.equal(final.verdict.passed, false);
});

test('conclude: an accepted debate surfaces accepted:true with the verdict', async () => {
    const client = makeClient({ behavior: { verdicts: [{ passed: true, score: 90, reason: 'ok', revision: 'minor' }] } });
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });

    /** @type {any} */ const final = await group.conclude({ instruction: 'topic', options: { judge: { minScore: 50 } } });
    assert.equal(final.accepted, true);
    assert.equal(final.verdict.score, 90);
    assert.equal(final.content, 'FINAL ANSWER');
});

test('conclude: tail propagates to judge and aggregate windows', async () => {
    const client = makeClient({ behavior: { verdicts: [{ passed: true, score: 90, reason: 'ok', revision: 'minor' }] } });
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });
    group.appendLedger({ entries: [
        { author: 'A', content: 'seed a', type: 'discussion', thoughtSignature: null },
        { author: 'A', content: 'seed b', type: 'discussion', thoughtSignature: null }
    ] });

    await group.conclude({ instruction: 'topic', options: { judge: { tail: 1 }, aggregate: { tail: 1 }, discuss: { tail: 1 } } });

    const withInstruction = client.calls.filter((/** @type {any} */ c) => c.input.some((/** @type {any} */ m) => String(m.content).startsWith('Evaluate the discussion') || String(m.content).startsWith('Synthesize the entire')));
    for (const call of withInstruction) {
        assert.ok(call.input.length <= 3, `window capped: ${call.input.length} messages`);
    }
});

// ─── planForEach DAG enforcement (the LLM's emission order is not execution order) ─

test('planForEach: steps execute in dependency order, not planner emission order', async () => {
    /** @type {any[]} */ const execCalls = [];
    const client = {
        execCalls,
        session() {
            /** @type {any} */
            const s = {
                provider: 'openai',
                withSystemMessage(/** @type {any} */ m) { this.sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : m; return this; },
                withTools() { return this; },
                withParameters() { return this; },
                /** @param {{initialInput: *}} arg0 */
                async run({ initialInput: input }) {
                    const text = typeof input === 'string' ? input : String(input[0]?.content ?? '');
                    if (this.sys && this.sys.includes('DAG Workflow Planner')) {
                        return JSON.stringify({
                            summary: 'plan',
                            steps: [
                                { id: 'write', title: 'Write', systemPrompt: 'Write up', userPromptTemplate: 'Write using: {{gather.output}}', dependencies: ['gather'] },
                                { id: 'gather', title: 'Gather', systemPrompt: 'Gather facts', userPromptTemplate: 'Gather for: {{context.topic}}', dependencies: [] }
                            ]
                        });
                    }
                    execCalls.push(text);
                    return `answer from ${this.sys ?? 'no-sys'}`;
                }
            };
            return s;
        }
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'First person.', model: 'mA', provider: 'openai' });

    await group.planForEach({ instruction: 'Research the topic.', options: { context: { topic: 'lazy evaluation' } } });

    assert.ok(execCalls[0].startsWith('Gather for:'), 'gather runs first despite the emission order');
    assert.ok(execCalls[1].startsWith('Write using: answer from Gather facts'), 'the write prompt resolves the gather output');
    assert.ok(!execCalls[1].includes('[UNRESOLVED'), 'no unresolved placeholder in the dependent step');
});

test('planForEach: a failed step gates its dependents (no model call, explicit error)', async () => {
    /** @type {any[]} */ const execCalls = [];
    const client = {
        execCalls,
        session() {
            /** @type {any} */
            const s = {
                provider: 'openai',
                withSystemMessage(/** @type {any} */ m) { this.sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : m; return this; },
                withTools() { return this; },
                withParameters() { return this; },
                /** @param {{initialInput: *}} arg0 */
                async run({ initialInput: input }) {
                    const text = typeof input === 'string' ? input : String(input[0]?.content ?? '');
                    if (this.sys && this.sys.includes('DAG Workflow Planner')) {
                        return JSON.stringify({
                            summary: 'plan',
                            steps: [
                                { id: 'gather', title: 'Gather', systemPrompt: 'Gather facts', userPromptTemplate: 'Gather.', dependencies: [] },
                                { id: 'write', title: 'Write', systemPrompt: 'Write up', userPromptTemplate: 'Write using: {{gather.output}}', dependencies: ['gather'] }
                            ]
                        });
                    }
                    if (this.sys && this.sys.includes('Gather facts')) {
                        return FALLBACK_MESSAGE.EMPTY_RESPONSE;
                    }
                    execCalls.push(text);
                    return `answer from ${this.sys ?? 'no-sys'}`;
                }
            };
            return s;
        }
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });

    await group.planForEach({ instruction: 'topic' });

    assert.equal(execCalls.length, 0, 'the dependent never ran');
    const errorEntries = group.getLedger().filter((/** @type {any} */ e) => String(e.content).startsWith('[error:'));
    assert.ok(errorEntries.length >= 1, 'the failure is recorded as an error entry');
    assert.ok(errorEntries.some((/** @type {any} */ e) => e.content.includes('dependency "gather" failed')), 'the skip names the failed dependency');
});

// ─── fallback/empty output guard (#runAgentTurn) ─────────────────────────────

test('discuss: a fallback-returning agent records an error entry, not a fake success', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'alpha', execute: async () => 'The model reached the maximum tool iteration limit and could not provide a final text response.' });

    await group.discuss({ instruction: 'go', turns: 1, sequential: true });

    /** @type {any} */ const ledger = group.getLedger();
    assert.equal(ledger.length, 1);
    assert.match(ledger[0].content, /\[error:/);
    assert.match(ledger[0].content, /iteration limit reached/, 'the diagnosis names the cause');
    assert.ok(ledger[0].content.length < 100, 'the raw fallback text is not stored as content');
});

test('judge: refuses to fabricate a verdict on an empty discussion', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });

    /** @type {any} */ const verdict = await group.judge({ instruction: 'Evaluate.', options: { asVerdict: true } });
    assert.equal(verdict.passed, false);
    assert.equal(verdict.score, 0);
    assert.match(verdict.reason, /No substantive discussion/);
    assert.equal(client.calls.filter((/** @type {any} */ c) => c.input.some((/** @type {any} */ m) => String(m.content).includes('Evaluate the discussion'))).length, 0, 'no LLM call for an empty discussion');
});

test('runTasks: a typo in dependsOn is surfaced, not silently ignored', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });
    /** @type {any[]} */ const errors = [];
    group.on('discussion:agent_error', (e) => errors.push(e));

    await group.runTasks({ tasks: [
        { title: 'one', description: 'd', assignee: 'A' },
        { title: 'two', description: 'd', assignee: 'A', dependsOn: ['one', 'typo'] }
    ] });

    assert.ok(errors.some(e => e.error.includes('unknown task "typo"')), 'the dangling dependency is reported');
    assert.equal(group.getLedger().length, 2, 'both tasks still ran');
});

// ─── D1: deterministic parallel ordering ────────────────────────────────────

test('discuss: parallel agents commit in registration order, not completion order', async () => {
    const client = {
        session() {
            /** @type {any} */
            const s = {
                provider: 'openai',
                withSystemMessage(/** @type {any} */ m) { this.sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : m; return this; },
                withTools() { return this; },
                withParameters() { return this; },
                /** @param {{initialInput: *}} arg0 */
                async run({ initialInput: input }) {
                    if (this.sys === 'A') await new Promise(r => setTimeout(r, 40));
                    return `from ${this.sys}`;
                }
            };
            return s;
        }
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'A', model: 'mA', provider: 'openai' });
    group.addAgent({ name: 'B', persona: 'B', model: 'mB', provider: 'openai' });
    /** @type {any[]} */ const finishOrder = [];
    group.on('discussion:agent_finish', (e) => finishOrder.push(e.agent));

    await group.discuss({ instruction: 'go', turns: 1 });

    /** @type {any} */ const ledger = group.getLedger();
    assert.deepEqual(ledger.map((/** @type {any} */ e) => e.author), ['A', 'B'], 'registration order in the ledger');
    assert.deepEqual(finishOrder, ['A', 'B'], 'agent_finish events fire in registration order');
});

test('discuss: a failing parallel agent still commits its [error:] entry in place', async () => {
    const client = {
        session() {
            /** @type {any} */
            const s = {
                provider: 'openai',
                withSystemMessage(/** @type {any} */ m) { this.sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : m; return this; },
                withTools() { return this; },
                withParameters() { return this; },
                async run() {
                    if (this.sys === 'B') throw new Error('boom');
                    return `from ${this.sys}`;
                }
            };
            return s;
        }
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'A', model: 'mA', provider: 'openai' });
    group.addAgent({ name: 'B', persona: 'B', model: 'mB', provider: 'openai' });

    await group.discuss({ instruction: 'go', turns: 1 });

    /** @type {any} */ const ledger = group.getLedger();
    assert.equal(ledger.length, 2, 'both entries committed');
    assert.equal(ledger[0].author, 'A');
    assert.equal(ledger[1].author, 'B');
    assert.match(ledger[1].content, /\[error: boom\]/, 'the failed agent is an error entry at its registration slot');
});

// ─── R1: termination conditions ─────────────────────────────────────────────

test('discuss: a mention token terminates after the turn commits', async () => {
    const client = {
        session() {
            /** @type {any} */
            const s = {
                provider: 'openai',
                withSystemMessage(/** @type {any} */ m) { this.sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : m; return this; },
                withTools() { return this; },
                withParameters() { return this; },
                async run() { return this.sys === 'B' ? 'final APPROVE' : 'arg'; }
            };
            return s;
        }
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'A', model: 'mA', provider: 'openai' });
    group.addAgent({ name: 'B', persona: 'B', model: 'mB', provider: 'openai' });
    const terminated = [];
    group.on('discussion:terminated', (e) => terminated.push(e));

    /** @type {any} */ const r = await group.discuss({ instruction: 'go', turns: 3, termination: 'APPROVE' });

    assert.equal(r.stopped, true);
    assert.match(r.reason, /APPROVE/);
    assert.equal(r.turns, 1, 'stopped after the first turn');
    assert.equal(terminated.length, 1);
    assert.equal(group.getLedger().length, 2, 'the terminating turn fully committed');
});

test('discuss: a predicate termination stops when it returns true', async () => {
    const client = {
        session() {
            /** @type {any} */
            const s = {
                provider: 'openai',
                withSystemMessage(/** @type {any} */ m) { this.sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : m; return this; },
                withTools() { return this; },
                withParameters() { return this; },
                async run() { return 'content'; }
            };
            return s;
        }
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'A', model: 'mA', provider: 'openai' });

    let seen = 0;
    /** @param {{ledger: *}} arg0 */
    /** @type {any} */ const r = await group.discuss({ instruction: 'go', turns: 3, termination: /** @type {(...args: any[]) => any} */ (({ ledger }) => { seen = ledger.length; return ledger.length >= 1; }) });
    assert.equal(r.stopped, true);
    assert.equal(seen, 1);
    assert.equal(r.turns, 1);
});

// ─── R4: graceful stop ──────────────────────────────────────────────────────

test('discuss: requestStop finishes the current turn then stops (graceful)', async () => {
    const client = {
        session() {
            /** @type {any} */
            const s = {
                provider: 'openai',
                withSystemMessage(/** @type {any} */ m) { this.sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : m; return this; },
                withTools() { return this; },
                withParameters() { return this; },
                async run() { return `from ${this.sys}`; }
            };
            return s;
        }
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'A', model: 'mA', provider: 'openai' });
    group.addAgent({ name: 'B', persona: 'B', model: 'mB', provider: 'openai' });
    group.on('discussion:turn_start', ({ turn }) => { if (turn === 2) group.requestStop({ reason: 'enough' }); });

    /** @type {any} */ const r = await group.discuss({ instruction: 'go', turns: 3 });

    assert.equal(r.stopped, true);
    assert.equal(r.reason, 'enough');
    assert.equal(r.turns, 2, 'the in-flight turn completed before stopping');
    assert.equal(group.getLedger().length, 4, 'turns 1 and 2 fully committed');
    /** @type {any} */ const r2 = await group.discuss({ instruction: 'go', turns: 1 });
    assert.equal(r2.stopped, false);
});

// ─── R2: reset ─────────────────────────────────────────────────────────────

test('reset: clears the ledger and the stop latch; resume continues from the ledger', async () => {
    const client = {
        session() {
            /** @type {any} */
            const s = {
                provider: 'openai',
                withSystemMessage(/** @type {any} */ m) { this.sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : m; return this; },
                withTools() { return this; },
                withParameters() { return this; },
                async run() { return `from ${this.sys}`; }
            };
            return s;
        }
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'A', model: 'mA', provider: 'openai' });

    await group.discuss({ instruction: 'first', turns: 1 });
    assert.equal(group.getLedger().length, 1);

    await group.discuss({ instruction: 'second', turns: 1 });
    assert.equal(group.getLedger().length, 2, 'resume appends to the existing ledger');

    group.requestStop({ reason: 'stop' });
    group.reset();
    assert.equal(group.getLedger().length, 0, 'reset clears the ledger');
    /** @type {any} */ const r = await group.discuss({ instruction: 'third', turns: 1 });
    assert.equal(r.stopped, false, 'reset clears the stop latch');
});

// ─── R3: typed tool-call events ─────────────────────────────────────────────

test('discuss: tool_call_start/end events surface an agent\'s tool use', async () => {
    const client = {
        session() {
            /** @type {any} */
            const s = {
                provider: 'openai',
                withSystemMessage() { return this; },
                withTools() { return this; },
                withParameters() { return this; },
                /** @param {{initialInput: *, options: *}} arg0 */
                async run({ initialInput: input, options: opts }) {
                    opts.onEvent({ type: 'tool_call_start', name: 'grep', args: '{"q":"x"}' });
                    opts.onEvent({ type: 'tool_call_end', name: 'grep', result: 'hit' });
                    return 'answer';
                }
            };
            return s;
        }
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'A', model: 'mA', provider: 'openai' });
    /** @type {any[]} */ const seen = [];
    group.on('discussion:tool_call_start', (e) => seen.push(['start', e]));
    group.on('discussion:tool_call_end', (e) => seen.push(['end', e]));

    await group.discuss({ instruction: 'go', turns: 1 });

    assert.equal(seen.length, 2);
    assert.equal(seen[0][0], 'start');
    assert.equal(seen[0][1].name, 'grep');
    assert.equal(seen[0][1].agent, 'A');
    assert.equal(seen[1][1].result, 'hit');
});

// ─── D3: duplicates ─────────────────────────────────────────────────────────

test('runTasks: duplicate titles throw instead of silently dropping the later task', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });
    await assert.rejects(
        () => group.runTasks({ tasks: [
            { title: 'one', description: 'd', assignee: 'A' },
            { title: 'one', description: 'd2', assignee: 'A' }
        ] }),
        /duplicate task title "one"/
    );
});

test('planForEach: duplicate planned step ids throw', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'First person.', model: 'mA', provider: 'openai' });
    client.session = () => {
        const s = makeSession({ sys: 'm', calls: [], behavior: {} });
        s.sys = 'DAG Workflow Planner';
        s.run = async () => JSON.stringify({
            summary: 'plan',
            steps: [
                { id: 'x', title: 'X', systemPrompt: 's', userPromptTemplate: 't', dependencies: [] },
                { id: 'x', title: 'X2', systemPrompt: 's', userPromptTemplate: 't', dependencies: [] }
            ]
        });
        return s;
    };
    await assert.rejects(() => group.planForEach({ instruction: 'topic' }), /invalid DAG .*duplicate/);
});

// ─── R1 in conclude: a terminated debate is aggregated as-is, never re-litigated ─

test('conclude: a self-terminated discussion skips the judge loop and aggregates', async () => {
    const client = makeClient({ behavior: { verdicts: [] } });
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });
    client.session = (/** @type {any} */ model) => {
        const s = makeSession({ sys: model, calls: client.calls, behavior: {} });
        const origRun = s.run.bind(s);
        s.run = async (/** @type {any} */ { initialInput: input, options: opts }) => {
            if (String(input[0]?.content ?? '').includes('All arguments are on the table')) {
                return 'We agree: APPROVE';
            }
            return origRun({ initialInput: input, options: opts });
        };
        return s;
    };

    /** @type {any} */ const final = await group.conclude({ instruction: 'topic', options: { discuss: { termination: 'APPROVE' } } });

    assert.equal(final.stopped, true, 'the stop is surfaced on the result');
    assert.equal(final.verdict, null, 'no judge verdict was fabricated');
    assert.equal(final.accepted, false, 'nothing was judged — accepted stays false');
    assert.equal(group.getLedger().length, 2, 'discuss entry + aggregate entry only');
});

// ─── B4/D2: summary cache invariants after the per-callback refactor ────────

test("summary cache: parallel agents with the same window dedupe to one summarize call", async () => {
    const calls = [];
    const summarize = async (/** @type {any} */ text) => { calls.push(text); return "S" + calls.length; };
    const client = makeClient();
    const grp = new DiscussionSession({ client });
    grp.addAgent({ name: "A", persona: "A", model: "mA", provider: "openai" });
    grp.addAgent({ name: "B", persona: "B", model: "mB", provider: "openai" });
    grp.appendLedger({ entries: [{ author: "a0", content: "entry0", type: "discussion", thoughtSignature: null }] });
    grp.appendLedger({ entries: [{ author: "a1", content: "entry1", type: "discussion", thoughtSignature: null }] });

    await grp.discuss({ instruction: "go", turns: 1, tail: 1, summarize });

    assert.equal(calls.length, 1, "one summarize call for the shared window, not one per agent");
});

test("summary cache: a different callback never reuses another's fold", async () => {
    const calls = [];
    const summarize = async (/** @type {any} */ text) => { calls.push(text); return "S" + calls.length; };
    const client = makeClient();
    const grp = new DiscussionSession({ client });
    grp.addAgent({ name: "alpha", model: "m", provider: "openai" });
    grp.appendLedger({ entries: [{ author: "a0", content: "entry0", type: "discussion", thoughtSignature: null }] });
    grp.appendLedger({ entries: [{ author: "a1", content: "entry1", type: "discussion", thoughtSignature: null }] });

    await grp.discuss({ instruction: "t1", turns: 1, tail: 1, summarize });
    const summarize2 = async (/** @type {any} */ text) => { calls.push(`2:${text}`); return "T"; };
    await grp.discuss({ instruction: "t2", turns: 1, tail: 1, summarize: summarize2 });
    assert.equal(calls.length, 2, "a different callback recomputes, never reuses another's fold");
});
// ─── L4: the PASS affordance ────────────────────────────────────────────────

test('discuss: an exact PASS with allowPass records a pass entry, not an error', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'alpha', execute: async () => 'PASS' });
    /** @type {any[]} */ const passed = [];
    group.on('discussion:agent_pass', (e) => passed.push(e));

    await group.discuss({ instruction: 'go', turns: 1, sequential: true, allowPass: true });

    /** @type {any} */ const ledger = group.getLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].pass, true);
    assert.equal(ledger[0].content, '[pass]');
    assert.equal(passed.length, 1);
    assert.equal(passed[0].agent, 'alpha');
});

test('discuss: PASS without allowPass is an error entry', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'alpha', execute: async () => 'PASS' });

    await group.discuss({ instruction: 'go', turns: 1, sequential: true });

    /** @type {any} */ const ledger = group.getLedger();
    assert.equal(ledger.length, 1);
    assert.match(ledger[0].content, /\[error:.*allowPass/, 'passing without the affordance is a failure');
});

test('discuss: judge and aggregate never accept PASS (a verdict is mandatory)', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });
    group.appendLedger({ entries: [{ author: 'A', content: 'a real contribution', type: 'discussion', thoughtSignature: null }] });

    /** @type {any[]} */ const calls = [];
    client.session = (/** @type {any} */ model) => {
        const s = makeSession({ sys: model, calls, behavior: {} });
        const orig = s.run.bind(s);
        s.run = async function (/** @type {any} */ input, /** @type {any} */ opts) {
            if (this && this.sys && this.sys.includes('quality evaluator')) return 'PASS';
            return orig(input, opts);
        };
        return s;
    };
    /** @type {any} */ const verdict = await group.judge({ instruction: 'Evaluate.', options: /** @type {any} */ ({ asVerdict: true, allowPass: true }) });
    assert.equal(verdict.passed, false, 'a PASS judge cannot be a passing verdict');
    assert.match(verdict.reason, /PASS is not allowed/, 'the judge PASS is surfaced as the rejection reason');
    const errorEntries = group.getLedger().filter((/** @type {any} */ e) => String(e.content).startsWith('[error:'));
    assert.ok(errorEntries.some((/** @type {any} */ e) => e.content.includes('PASS is not allowed')), 'the judge PASS is recorded as an error entry');
});

test('discuss: pass entries are skipped in context and judged as no-substance', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', execute: async () => 'PASS' });
    await group.discuss({ instruction: 'go', turns: 1, sequential: true, allowPass: true });

    /** @type {any} */ const v = await group.judge({ instruction: 'Evaluate.', options: { asVerdict: true } });
    assert.equal(v.passed, false);
    assert.match(v.reason, /No substantive discussion/);
});

test('planForEach: a passed step leaves its outputs slot unset (dependent sees UNRESOLVED)', async () => {
    /** @type {any[]} */ const execCalls = [];
    const client = {
        execCalls,
        session() {
            /** @type {any} */
            const s = {
                provider: 'openai',
                withSystemMessage(/** @type {any} */ m) { this.sys = Array.isArray(m) ? m.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n') : m; return this; },
                withTools() { return this; },
                withParameters() { return this; },
                /** @param {{initialInput: *}} arg0 */
                async run({ initialInput: input }) {
                    const text = typeof input === 'string' ? input : String(input[0]?.content ?? '');
                    if (this.sys && this.sys.includes('DAG Workflow Planner')) {
                        return JSON.stringify({
                            summary: 'plan',
                            steps: [
                                { id: 'gather', title: 'Gather', systemPrompt: 'Gather facts', userPromptTemplate: 'Gather.', dependencies: [] },
                                { id: 'write', title: 'Write', systemPrompt: 'Write up', userPromptTemplate: 'Write using: {{gather.output}}', dependencies: ['gather'] }
                            ]
                        });
                    }
                    if (this.sys && this.sys.includes('Gather facts')) return 'PASS';
                    execCalls.push(text);
                    return 'answer';
                }
            };
            return s;
        }
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: 'openai' });

    await group.planForEach({ instruction: 'topic', options: { allowPass: true } });

    assert.ok(execCalls[0].includes('[UNRESOLVED: {{gather.output}}]'), 'a passed dependency leaves the slot unset');
    const passEntries = group.getLedger().filter((/** @type {any} */ e) => e.pass === true);
    assert.equal(passEntries.length, 1, 'the pass is recorded, not an error');
});

// ─── Scheduler-core routing ──────────────────────────────────────────────────

test('MAA: agent sessions carry the client-registry breaker; open breaker fail-fasts the turn with zero backend calls', async () => {
    const { getCircuitBreaker, BREAKER_OPEN_CODE } = await import('../lib/support/retry-policy.mjs');
    /** @type {any[]} */ const attached = [];
    let backendCalls = 0;
    const client = {
        session: (/** @type {any} */ model) => {
            /** @type {any} */
            const s = {
                provider: 'openai', model,
                withSystemMessage() { return s; },
                withTools() { return s; },
                /** @param {{breaker: *}} arg0 */
                withCircuitBreaker(/** @type {any} */ { breaker }) { attached.push(breaker); s._breaker = breaker; return s; },
                async run() {
                    if (s._breaker && !s._breaker.canRun()) {
                        throw Object.assign(new Error('Circuit breaker open'), { code: BREAKER_OPEN_CODE });
                    }
                    backendCalls++;
                    s._breaker?.recordSuccess();
                    return 'turn answer';
                },
            };
            return s;
        },
    };
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'm', provider: 'openai' });
    group.addAgent({ name: 'B', persona: 'p', model: 'm', provider: 'openai' });

    await group.runTasks({ tasks: [{ title: 't1', description: 'do it', assignee: 'A' }] });
    assert.equal(backendCalls, 1);
    assert.ok(attached.length >= 1, 'agent session received a breaker');
    assert.equal(attached[0], getCircuitBreaker({ client, key: 'openai:m' }), 'breaker is the client-registry instance');

    for (let i = 0; i < 5; i++) getCircuitBreaker({ client, key: 'openai:m' }).recordFailure();
    await group.runTasks({ tasks: [{ title: 't2', description: 'do it', assignee: 'B' }] });
    assert.equal(backendCalls, 1, 'open breaker made zero additional backend calls');
    const errors = group.getLedger().filter((/** @type {any} */ e) => String(e.content ?? '').startsWith('[error:'));
    assert.ok(errors.length >= 1, 'failed turn recorded as an honest [error:] ledger entry');
});

// ─── aggregate / conclude: a failed aggregation is never a deliverable ───────

test('aggregate: a failed aggregation turn records an [error: …] entry, not a fake answer', async () => {
    const client = makeClient();
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'm', provider: 'openai' });
    group.appendLedger({ entries: [{ author: 'A', content: 'a real contribution', type: 'discussion', thoughtSignature: null }] });

    /** @type {any} */ const entry = await group.aggregate({ instruction: 'finalize', options: {
        execute: async () => { throw new Error('boom'); },
    } });

    assert.match(entry.content, /^\[error: boom\]/, 'the failure is recorded honestly');
});

test('conclude: accepted is false when the aggregation turn fails (an error entry is not a deliverable)', async () => {
    const client = makeClient({ behavior: {
        verdicts: [{ passed: true, score: 90, reason: 'ok', revision: 'minor' }],
        aggregateOutput: '',
    } });
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'm', provider: 'openai' });

    /** @type {any} */ const final = await group.conclude({ instruction: 'topic', options: { judge: { minScore: 50 } } });

    assert.equal(final.accepted, false, 'a passing verdict cannot bless a failed aggregation');
    assert.equal(final.error, true, 'the failure is machine-readable, not string-matched');
    assert.match(String(final.content), /^\[error:/, 'the final entry names the failure');
    assert.equal(final.verdict.passed, true, 'the verdict itself is still reported');
});

test('conclude: an SDK-fallback aggregation is marked error, not accepted', async () => {
    const client = makeClient({ behavior: {
        verdicts: [{ passed: true, score: 90, reason: 'ok', revision: 'minor' }],
        aggregateOutput: FALLBACK_MESSAGE.EMPTY_RESPONSE,
    } });
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'm', provider: 'openai' });

    /** @type {any} */ const final = await group.conclude({ instruction: 'topic', options: { judge: { minScore: 50 } } });

    assert.equal(final.accepted, false);
    assert.equal(final.error, true);
    assert.match(String(final.content), /empty-response fallback/);
});

test('conclude: accepted stays true when the aggregation produces real content', async () => {
    const client = makeClient({ behavior: { verdicts: [{ passed: true, score: 90, reason: 'ok', revision: 'minor' }] } });
    const group = new DiscussionSession({ client });
    group.addAgent({ name: 'A', persona: 'p', model: 'm', provider: 'openai' });

    /** @type {any} */ const final = await group.conclude({ instruction: 'topic', options: { judge: { minScore: 50 } } });

    assert.equal(final.accepted, true);
    assert.equal(final.error, false, 'a healthy conclusion is not flagged as an error');
    assert.equal(final.content, 'FINAL ANSWER');
});
