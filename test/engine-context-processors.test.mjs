// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { StateMachine } from '../lib/agentic/state-machine/machine.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';

/** @param {string} output @returns {any} */
function capturingClient(output = 'ok') {
    const sessions = /** @type {any[]} */ ([]);
    return {
        provider: 'openai',
        sessions,
        session() {
            const s = {
                provider: 'openai',
                withSystemMessage() { return s; },
                withTools() { return s; },
                withMemory() { return s; },
                withTodos() { return s; },
                withParameters() { return s; },
                withRetryPolicy() { return s; },
                withStreamTimeout() { return s; },
                withApproval() { return s; },
                withHeaderTimeout() { return s; },
                withMaxElapsedMs() { return s; },
                withBudget() { return s; },
                withCircuitBreaker() { return s; },
                async run() { return output; },
            };
            sessions.push(s);
            return s;
        },
    };
}

const PROC = { name: 'p', order: 0, process: async () => ({ contextParts: ['B1-BLOCK'] }) };
/** @param {any[]} sessions */
const hasProc = (sessions) => sessions.some((s) => Array.isArray(s._contextProcessors) && s._contextProcessors.includes(PROC));

test('DAG: step sessions receive the executor contextProcessors', async () => {
    const client = capturingClient();
    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm', contextProcessors: [PROC] } });
    exec.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'Do', dependencies: [] }] });
    await exec.execute({ userGoal: 'g' });
    assert.ok(hasProc(client.sessions), 'the step session carries the processor');
});

test('StateMachine: node sessions receive contextProcessors', async () => {
    const client = capturingClient();
    const sm = new StateMachine({ graph: { entry: 'a', nodes: [{ id: 'a', terminal: true, userPromptTemplate: 'Do' }], edges: [] }, options: { client, defaultModel: 'm', contextProcessors: [PROC] } });
    await sm.run({});
    assert.ok(hasProc(client.sessions));
});

test('Discussion: agent-turn sessions receive contextProcessors', async () => {
    const client = capturingClient();
    const group = new DiscussionSession({ client, options: { contextProcessors: [PROC] } });
    group.addAgent({ name: 'A', persona: 'p', model: 'm', provider: 'openai' });
    await group.discuss({ instruction: 'Speak.', turns: 1 });
    assert.ok(hasProc(client.sessions));
});

test('no processors means no session receives one (no regression)', async () => {
    const client = capturingClient();
    const exec = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
    exec.setSteps({ stepsList: [{ id: 'a', userPromptTemplate: 'Do', dependencies: [] }] });
    await exec.execute({ userGoal: 'g' });
    assert.equal(client.sessions.some((/** @type {any} */ s) => Array.isArray(s._contextProcessors) && s._contextProcessors.length), false);
});
