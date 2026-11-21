// @ts-check
/**
 * The subagent journal boundary was `task:<agent>:` for every delegation to the
 * same agent, so two delegations that ask the same agent to run the same tool
 * with the same arguments hashed to one key: the second replayed the first's
 * outcome instead of running. Each delegation has its own spawn record, whose
 * id is stable across the retries of that delegation and unique across
 * delegations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { withTaskAgents, runTaskChild } from '../lib/agentic/task.mjs';
import { getSpawnRegistry } from '../lib/agentic/spawn-registry.mjs';
import { ExecutionJournal } from '../lib/agentic/journal.mjs';
import { ChatSession as OaiChatSession } from '../lib/backends/oai.mjs';

const CALL = { id: 'c1', name: 'count', arguments: '{"n":1}' };

/**
 * A child whose model asks for the same tool call once, then answers.
 * @param {{client: any, model: string, counter: {n: number}}} arg0
 */
function makeChild({ client, model, counter }) {
    const session = /** @type {any} */ (new OaiChatSession({ client, model, eventEmitter: new EventEmitter() }));
    session.withTools({ tools: [{
        name: 'count',
        parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
        execute: async () => { counter.n += 1; return `count=${counter.n}`; },
    }] });
    let calls = 0;
    /** @param {{messages: any}} arg0 @returns {AsyncGenerator<any, any>} */
    session.step = async function* step({ messages }) {
        calls += 1;
        if (calls === 1) {
            const results = yield { type: 'tool_request', calls: [CALL] };
            return {
                done: true,
                content: '',
                messages: [...messages,
                    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'count', arguments: '{"n":1}' } }] },
                    { role: 'tool', tool_call_id: 'c1', name: 'count', content: String(results?.[0]?.result ?? '') },
                ],
            };
        }
        return { done: true, content: 'child answer', messages };
    };
    return session;
}

/** @param {{counter: {n: number}, journal: ExecutionJournal}} arg0 */
function tree({ counter, journal }) {
    const client = /** @type {any} */ ({ provider: 'openai', emit() { return false; } });
    client.session = (/** @type {string} */ model) => makeChild({ client, model, counter });
    const parent = /** @type {any} */ ({
        provider: 'openai',
        model: 'parent-model',
        client,
        eventEmitter: new EventEmitter(),
        _tools: [],
        _taskDepth: 0,
        _lastStepMessages: [],
        _journal: journal,
        withToolAllowlist() { return parent; },
        withSystemMessage() { return parent; },
        withTools() { return parent; },
    });
    withTaskAgents({ client, agents: [{ name: 'worker', model: 'child-model' }] });
    return { client, parent };
}

/** @param {{client: any, parent: any, prompt: string}} arg0 */
const delegate = ({ client, parent, prompt }) => runTaskChild({
    session: parent,
    profile: /** @type {any} */ (getSpawnRegistry({ client }).agents.get('worker')),
    args: { description: 'x', prompt, subagent_type: 'worker' },
    signal: undefined,
    eventEmitter: parent.eventEmitter,
});

test('two delegations to the same agent do not replay each other', async () => {
    const journal = new ExecutionJournal();
    const counter = { n: 0 };
    const { client, parent } = tree({ counter, journal });
    await delegate({ client, parent, prompt: 'do the thing' });
    await delegate({ client, parent, prompt: 'do the thing' });
    assert.equal(counter.n, 2, 'each delegation runs its own tool call');
});

test('each delegation writes its own journal boundary', async () => {
    const journal = new ExecutionJournal();
    const counter = { n: 0 };
    const { client, parent } = tree({ counter, journal });
    await delegate({ client, parent, prompt: 'do the thing' });
    await delegate({ client, parent, prompt: 'do the thing' });
    const boundaries = journal.entries().map((/** @type {any} */ entry) => entry.boundary);
    assert.equal(boundaries.length, 2);
    assert.notEqual(boundaries[0], boundaries[1], `both delegations used ${boundaries[0]}`);
    assert.match(String(boundaries[0]), /^task:worker:/);
});
