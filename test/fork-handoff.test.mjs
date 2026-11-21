// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { normalizeHandoff } from '../lib/agentic/agent-context.mjs';
import { withTaskAgents, createTaskTool } from '../lib/agentic/task.mjs';

/** @param {string} provider @returns {any} */
function makeForkClient(provider = 'openai') {
    const runs = /** @type {any[][]} */ ([]);
    return {
        provider,
        runs,
        session() {
            const s = {
                provider,
                withSystemMessage() { return s; },
                withTools() { return s; },
                withRetryPolicy() { return s; },
                withHeaderTimeout() { return s; },
                withMaxElapsedMs() { return s; },
                withApproval() { return s; },
                withBudget() { return s; },
                withCircuitBreaker() { return s; },
                /** @param {{initialInput: any[]}} arg0 */
                async run({ initialInput }) { runs.push(initialInput); return 'child answer'; },
            };
            return s;
        },
    };
}

/** @param {{client: any, last?: any[]}} arg0 @returns {any} */
function parentSession({ client, last = [] }) {
    return {
        client,
        model: 'parent-model',
        provider: client.provider,
        eventEmitter: new EventEmitter(),
        _taskDepth: 0,
        _lastStepMessages: last,
    };
}

const U = { role: 'user', content: 'parent question', merciId: 'm1' };
const A = { role: 'assistant', content: 'parent answer', merciId: 'm2' };

test('normalizeHandoff accepts the fork context mode', () => {
    assert.equal(normalizeHandoff({ handoff: { context: 'fork' } }).context, 'fork');
});

test('task: context:"fork" seeds the child with the parent rows (ids preserved)', async () => {
    const client = makeForkClient('openai');
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = parentSession({ client, last: [U, A] });
    await /** @type {any} */ (createTaskTool({ session })).execute({ args: {
        prompt: 'Do X', subagent_type: 'worker', handoff: { context: 'fork' },
    } });
    const input = client.runs[0];
    assert.equal(input.length, 3, 'two forked rows + the brief');
    assert.equal(input[0].content, 'parent question');
    assert.equal(input[0].merciId, 'm1', 'row identity preserved (cache-friendly)');
    assert.equal(input[1].content, 'parent answer');
    assert.equal(input[1].merciId, 'm2');
    assert.ok(String(input[2].content).includes('Do X'), 'the delegation brief is the trailing user turn');
    assert.equal(input[2].role, 'user');
});

test('task: context:"clean" sends only the brief (fork does not leak in)', async () => {
    const client = makeForkClient('openai');
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = parentSession({ client, last: [U, A] });
    await /** @type {any} */ (createTaskTool({ session })).execute({ args: {
        prompt: 'Do X', subagent_type: 'worker', handoff: { context: 'clean' },
    } });
    assert.equal(client.runs[0].length, 1);
    assert.equal(client.runs[0][0].content.includes('parent question'), false);
});

test('task: inherit:"history" keeps the legacy compacted block when context is unset', async () => {
    const client = makeForkClient('openai');
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm', inherit: 'history' }] });
    const session = parentSession({ client, last: [U, A] });
    await /** @type {any} */ (createTaskTool({ session })).execute({ args: {
        prompt: 'Do X', subagent_type: 'worker',
    } });
    const input = client.runs[0];
    assert.equal(input.length, 1, 'history is a text digest, not rows');
    assert.ok(String(input[0].content).includes('[Parent conversation (recent'), 'legacy compacted block present');
});

test('task: context:"full" overrides the legacy digest with real rows', async () => {
    const client = makeForkClient('openai');
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm', inherit: 'history' }] });
    const session = parentSession({ client, last: [U, A] });
    await /** @type {any} */ (createTaskTool({ session })).execute({ args: {
        prompt: 'Do X', subagent_type: 'worker', handoff: { context: 'full' },
    } });
    const input = client.runs[0];
    assert.equal(input.length, 3, 'two parent rows + the brief');
    assert.ok(!String(input[input.length - 1].content).includes('[Parent conversation (recent'), 'no digest on top of the rows');
});

test('task: cross-backend fork degrades visibly (digest rows + event), never silent', async () => {
    const parent = makeForkClient('openai');
    const other = makeForkClient('anthropic');
    withTaskAgents({ client: parent, agents: [{ name: 'worker', model: 'm', client: other }] });
    const session = parentSession({ client: parent, last: [U, A] });
    /** @type {any[]} */
    const degradations = [];
    session.eventEmitter.on('task:fork_degraded', (/** @type {any} */ e) => degradations.push(e));
    await /** @type {any} */ (createTaskTool({ session })).execute({ args: {
        prompt: 'Do X', subagent_type: 'worker', handoff: { context: 'fork' },
    } });
    assert.equal(degradations.length, 1, 'the degradation is observable, not silent');
    assert.equal(degradations[0].childProvider, 'anthropic');
    assert.ok(degradations[0].degraded >= 1, 'the foreign rows were degraded to digests');
    const input = other.runs[0];
    assert.ok(input.length >= 2, 'the child still receives the parent context as a digest + the brief');
    assert.ok(input.some((/** @type {any} */ m) => String(m.content).includes('parent question')), 'the parent content is visibly carried');
    assert.ok(String(input.at(-1).content).includes('Do X'), 'the brief is the trailing turn');
});

test('task: fork with no parent history degrades to the brief', async () => {
    const client = makeForkClient('openai');
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm' }] });
    const session = parentSession({ client, last: [] });
    await /** @type {any} */ (createTaskTool({ session })).execute({ args: {
        prompt: 'Do X', subagent_type: 'worker', handoff: { context: 'fork' },
    } });
    assert.equal(client.runs[0].length, 1);
    assert.ok(String(client.runs[0][0].content).includes('Do X'));
});
