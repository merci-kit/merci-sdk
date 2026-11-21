// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { StateMachine } from '../lib/agentic/state-machine/index.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { isObjectiveRestatePrompt } from '../lib/agentic/objective.mjs';

const POLICY = { callback: async () => true, timeoutMs: 50 };

/**
 * @param {{store: any[]}} arg0
 */
function recordingClient({ store }) {
    return {
        session: () => {
            /** @type {any} */
            const session = /** @type {any} */ (new Proxy(/** @type {any} */ ({ provider: 'openai', model: 'm', eventEmitter: { emit() {} }, _tools: [] }), {
                get(target, prop) {
                    if (prop === 'run') {
                        return async (/** @type {any} */ input) => (isObjectiveRestatePrompt({ input }) ? '' : 'answer');
                    }
                    if (typeof prop === 'string' && prop.startsWith('with')) return () => session;
                    return target[prop];
                },
                set(target, prop, value) { target[prop] = value; return true; },
            }));
            store.push(session);
            return session;
        },
    };
}

const STEP = { id: 'a', title: 'A', systemPrompt: 's', userPromptTemplate: 'u', dependencies: [] };

describe('2B: approval policy propagation', () => {
    it('the DAG executor passes its policy to step sessions', async () => {
        /** @type {any[]} */
        const sessions = [];
        const executor = new WorkflowExecutor({ options: { client: recordingClient({ store: sessions }), defaultModel: 'm', approval: POLICY } });
        executor.setSteps({ stepsList: [STEP] });
        await executor.execute({ userGoal: 'goal' });
        assert.ok(sessions.length >= 1);
        assert.equal(sessions[0]._approvalPolicy, POLICY);
    });

    it('the DAG executor passes its policy into the stateMachine engine', async () => {
        /** @type {any[]} */
        const sessions = [];
        const executor = new WorkflowExecutor({ options: {
            client: recordingClient({ store: sessions }),
            defaultModel: 'm',
            approval: POLICY,
            engine: 'stateMachine',
            contract: { maxRetries: 0 },
        } });
        executor.setSteps({ stepsList: [STEP] });
        await executor.execute({ userGoal: 'goal' });
        assert.ok(sessions.some((s) => s._approvalPolicy === POLICY), 'a node session must carry the policy');
    });

    it('a standalone StateMachine passes its policy to node sessions', async () => {
        /** @type {any[]} */
        const sessions = [];
        const sm = new StateMachine({ graph: {
            entry: 'a',
            nodes: [{ id: 'a', userPromptTemplate: 'do the thing', terminal: true }],
            edges: [],
        }, options: { client: recordingClient({ store: sessions }), defaultModel: 'm', approval: POLICY } });
        await sm.run();
        assert.ok(sessions.length >= 1);
        assert.equal(sessions[0]._approvalPolicy, POLICY);
    });

    it('a DiscussionSession passes its policy to agent sessions', async () => {
        /** @type {any[]} */
        const sessions = [];
        const group = new DiscussionSession({ client: recordingClient({ store: sessions }), options: { approval: POLICY } });
        group.addAgent({ name: 'A', model: 'm', provider: 'openai', persona: 'p' });
        await group.runTasks({ tasks: [{ title: 't', description: 'd', assignee: 'A' }] });
        assert.ok(sessions.length >= 1);
        assert.equal(sessions[0]._approvalPolicy, POLICY);
    });

    it("a session's own withApproval wins over the engine policy", async () => {
        /** @type {any[]} */
        const sessions = [];
        const own = { callback: async () => false };
        const executor = new WorkflowExecutor({ options: { client: recordingClient({ store: sessions }), defaultModel: 'm', approval: POLICY } });
        executor.setSteps({ stepsList: [STEP] });
        const client = /** @type {any} */ (executor.client);
        const originalSession = client.session;
        client.session = () => {
            const s = originalSession();
            s._approvalPolicy = own;
            return s;
        };
        await executor.execute({ userGoal: 'goal' });
        assert.equal(sessions[0]._approvalPolicy, own);
    });
});
