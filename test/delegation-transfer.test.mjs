// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { withTaskAgents, createTaskTool } from '../lib/agentic/task.mjs';

/** @param {string} provider @returns {any} */
function makeClient(provider = 'openai') {
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

/** @param {any[]} input */
const joined = (input) => input.map((m) => String(m?.content ?? '')).join('\n');

test('task: profile transfer:"ledger" replays the parent rows verbatim (ids preserved)', async () => {
    const client = makeClient('openai');
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm', transfer: 'ledger' }] });
    const session = parentSession({ client, last: [U, A] });
    await /** @type {any} */ (createTaskTool({ session })).execute({ args: {
        prompt: 'Do X', subagent_type: 'worker',
    } });
    const input = client.runs[0];
    assert.equal(input.length, 3, 'two parent rows + the brief');
    assert.equal(input[0].merciId, 'm1', 'row identity preserved (cache-friendly)');
    assert.equal(input[1].merciId, 'm2');
    assert.equal(input[2].role, 'user');
    assert.ok(String(input[2].content).includes('Do X'), 'the delegation brief is the trailing user turn');
});

test('task: transfer ledger-selected windows the parent run and suppresses the text digest', async () => {
    const client = makeClient('openai');
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm', inherit: 'history', transfer: { preset: 'ledger-selected', tail: 1 } }] });
    const session = parentSession({ client, last: [U, A, { role: 'user', content: 'third turn' }] });
    await /** @type {any} */ (createTaskTool({ session })).execute({ args: {
        prompt: 'Do X', subagent_type: 'worker',
    } });
    const input = client.runs[0];
    const text = joined(input);
    assert.ok(text.includes('[Earlier context omitted]'), 'the shared renderer frames the drop');
    assert.ok(text.includes('third turn'), 'the kept tail unit survives');
    assert.ok(!text.includes('parent question'), 'the dropped prefix is gone');
    assert.ok(!text.includes('[Parent conversation (recent'), 'ledger mode suppresses the legacy text digest');
});

test('task: transfer ledger on a foreign backend degrades rows to a visible digest (not a silent drop)', async () => {
    const parent = makeClient('openai');
    const other = makeClient('anthropic');
    withTaskAgents({ client: parent, agents: [{ name: 'worker', model: 'm', client: other, transfer: 'ledger' }] });
    const session = parentSession({ client: parent, last: [U, A] });
    await /** @type {any} */ (createTaskTool({ session })).execute({ args: {
        prompt: 'Do X', subagent_type: 'worker',
    } });
    const input = other.runs[0];
    assert.equal(input.length, 3, 'two digest rows + the brief');
    assert.ok(joined(input).includes('[Output from Step "parent-0"]'), 'the foreign rows are made visible as a digest');
});

test('task: handoff context:"clean" carries nothing even with a ledger transfer', async () => {
    const client = makeClient('openai');
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm', transfer: 'ledger' }] });
    const session = parentSession({ client, last: [U, A] });
    await /** @type {any} */ (createTaskTool({ session })).execute({ args: {
        prompt: 'Do X', subagent_type: 'worker', handoff: { context: 'clean' },
    } });
    assert.equal(client.runs[0].length, 1, 'clean wins: only the brief');
    assert.equal(joined(client.runs[0]).includes('parent question'), false);
});

test('task: no transfer keeps the legacy compacted history digest', async () => {
    const client = makeClient('openai');
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'm', inherit: 'history' }] });
    const session = parentSession({ client, last: [U, A] });
    await /** @type {any} */ (createTaskTool({ session })).execute({ args: {
        prompt: 'Do X', subagent_type: 'worker',
    } });
    const input = client.runs[0];
    assert.equal(input.length, 1, 'history is a text digest, not rows');
    assert.ok(joined(input).includes('[Parent conversation (recent'), 'legacy block present by default');
    assert.ok(!joined(input).includes('[Earlier context omitted]'), 'module framing is opt-in only');
});
