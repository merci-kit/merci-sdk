// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { withTaskAgents, createTaskTool } from '../lib/agentic/task.mjs';
import { DiscussionSession } from '../lib/agentic/discussion-session.mjs';
import { AgentContext } from '../lib/agentic/agent-context.mjs';
import { createSaveArtifactTool } from '../lib/agentic/artifacts.mjs';
import { ProviderType } from '../lib/core/constants/index.mjs';


/** @param {{calls?: *}} arg0 */
function makeClient({ calls = [] } = {}) {
    
    /** @type {any[]} */
        const systems = [];
    return {
        calls,
        systems,
        session: () => ({
            provider: 'openai',
            _system: '',
            /** @param {*} msg */
            withSystemMessage( msg) {
                // SP6: the child system may be a block list (template + adaptation).
                this._system = Array.isArray(msg)
                    ? msg.map((/** @type {any} */ b) => String(b?.text ?? '')).filter(Boolean).join('\n\n')
                    : String(msg ?? '');
                return this;
            },
            withTools() { return this; },
            withMemory() { return this; },
            withTodos() { return this; },
            withParameters() { return this; },
            /** @param {{initialInput: *}} arg0 */
            async run({ initialInput: messages }) { calls.push(messages); systems.push(this._system); return 'child answer'; },
        }),
    };
}


/** @param {any[]} calls @param {any[]} [systems] */
/** @param {{calls: *, systems?: *}} arg0 */
/** @param {{calls: *, systems?: *}} arg0 */
const childInputOf = ({ calls, systems = [] }) => {
    const first = calls[0];
    const user = Array.isArray(first) ? first.map(m => String(m?.content ?? '')).join('\n') : String(first);
    return [String(systems[0] ?? ''), user].filter(Boolean).join('\n');
};

describe('task tool: objective + structured brief reach the child', () => {
    it('the parent objective is appended even when the model writes no context', async () => {
        /** @type {any[]} */
        const calls =  ([]);
        const client = makeClient({ calls });
        withTaskAgents({ client: /** @type {any} */ (client), agents: [{ name: 'worker', model: 'm' }] });
        const tool = createTaskTool({ session: /** @type {any} */ ({
            client: /** @type {any} */ (client), model: 'm', provider: 'openai',
            eventEmitter: new EventEmitter(),
            _agentContext: AgentContext.fromObjective({ objective: 'ROOT GOAL: audit the fleet' }),
        }) });
        const result = await /** @type {any} */ (tool).execute({ args: { subagent_type: 'worker', prompt: 'List findings.' } });
        assert.equal(result, 'child answer');
        const input = childInputOf({ calls, systems: client.systems });
        assert.ok(input.includes('[Global Objective]'), 'the block is present');
        assert.ok(input.includes('ROOT GOAL: audit the fleet'), 'the objective rides verbatim');
        assert.ok(input.includes('List findings.'), 'the prompt rides');
    });

    it('the structured brief fields land verbatim in the child input', async () => {
        /** @type {any[]} */
        const calls =  ([]);
        const client = makeClient({ calls });
        withTaskAgents({ client: /** @type {any} */ (client), agents: [{ name: 'worker', model: 'm' }] });
        const tool = createTaskTool({ session: /** @type {any} */ ({
            client: /** @type {any} */ (client), model: 'm', provider: 'openai',
            eventEmitter: new EventEmitter(),
            _agentContext: AgentContext.fromObjective({ objective: 'ROOT GOAL' }),
        }) });
        await /** @type {any} */ (tool).execute({ args: {
            subagent_type: 'worker',
            prompt: 'Do X',
            objective: 'SUBTASK GOAL',
            context: 'fact A; ref: /artifacts/data.json',
            outputFormat: 'JSON array of {city, days}',
            constraints: 'do not touch prod',
        } });
        const input = childInputOf({ calls, systems: client.systems });
        assert.ok(input.includes('SUBTASK GOAL'));
        assert.ok(input.includes('fact A; ref: /artifacts/data.json'));
        assert.ok(input.includes('JSON array of {city, days}'));
        assert.ok(input.includes('do not touch prod'));
        assert.ok(input.includes('ROOT GOAL'), 'the parent objective is still appended');
    });

    it('a child without a parent context still runs (objective optional)', async () => {
        /** @type {any[]} */
        const calls =  ([]);
        const client = makeClient({ calls });
        withTaskAgents({ client: /** @type {any} */ (client), agents: [{ name: 'worker', model: 'm' }] });
        const tool = createTaskTool({ session: /** @type {any} */ ({ client: /** @type {any} */ (client), model: 'm', provider: 'openai', eventEmitter: new EventEmitter() }) });
        await /** @type {any} */ (tool).execute({ args: { subagent_type: 'worker', prompt: 'Do X' } });
        const input = childInputOf({ calls, systems: client.systems });
        assert.equal(input, 'Do X', 'bare prompt when nothing to inherit');
    });

    it('inherit:history appends the parent conversation window', async () => {
        /** @type {any[]} */
        const calls =  ([]);
        const client = makeClient({ calls });
        withTaskAgents({ client: /** @type {any} */ (client), agents: [{ name: 'worker', model: 'm', inherit: 'history' }] });
        const tool = createTaskTool({ session: /** @type {any} */ ({
            client: /** @type {any} */ (client), model: 'm', provider: 'openai',
            eventEmitter: new EventEmitter(),
            _agentContext: AgentContext.fromObjective({ objective: 'ROOT GOAL' }),
            _lastStepMessages: [
                { role: 'user', content: 'first question' },
                { role: 'assistant', content: 'first answer' },
            ],
        }) });
        await /** @type {any} */ (tool).execute({ args: { subagent_type: 'worker', prompt: 'Continue the work.' } });
        const input = childInputOf({ calls, systems: client.systems });
        assert.ok(input.includes('[Parent conversation (recent 2 rows)]'), 'the history block is present');
        assert.ok(input.includes('first question'));
        assert.ok(input.includes('first answer'));
        assert.ok(input.includes('ROOT GOAL'), 'the objective rides alongside');
    });
});

describe('MAA runTasks: subagent stages inherit the group objective', () => {
    it('the stage brief is framed by the group objective', async () => {
        /** @type {any[]} */
        const calls =  ([]);
        const client = makeClient({ calls });
        withTaskAgents({ client: /** @type {any} */ (client), agents: [{ name: 'fact_gatherer', model: 'm' }] });
        const group = new DiscussionSession({ client, options: { objective: 'GROUP GOAL: understand the market' } });
        group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: ProviderType.OPENAI });
        await group.runTasks({ tasks: [{ description: 'Gather facts about X', subagent_type: 'fact_gatherer' }] });
        const input = childInputOf({ calls, systems: client.systems });
        assert.ok(input.includes('GROUP GOAL: understand the market'), 'the group objective frames the stage');
        assert.ok(input.includes('Gather facts about X'), 'the description rides');
    });

    it('plain member turns also see the group objective (not only stages)', async () => {
        /** @type {any[]} */
        const calls =  ([]);
        const client = makeClient({ calls });
        const group = new DiscussionSession({ client, options: { objective: 'GROUP GOAL: debate the motion' } });
        group.addAgent({ name: 'A', persona: 'p', model: 'mA', provider: ProviderType.OPENAI });
        await group.discuss({ instruction: 'Take a stance.', turns: 1 });
        const input = childInputOf({ calls, systems: client.systems });
        assert.ok(input.includes('GROUP GOAL: debate the motion'),
            'the objective frames the member turn, not just delegation');
        assert.ok(input.includes('Take a stance.'), 'the instruction rides');
    });
});

describe('save_artifact: persist by reference, path-confined', () => {
    it('writes the content and returns the path', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-artifacts-'));
        try {
            const tool =  (createSaveArtifactTool({ dir }));
            const path = await tool.execute({ args: { name: 'findings.md', content: 'DATA' } });
            assert.ok(path.startsWith(dir), 'the path is inside the artifact dir');
            assert.equal(readFileSync(path, 'utf8'), 'DATA');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('sanitizes names and refuses escapes', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-artifacts-'));
        try {
            const tool =  (createSaveArtifactTool({ dir }));
            const path = await tool.execute({ args: { name: '../../etc/passwd', content: 'X' } });
            assert.ok(path.startsWith(`${normalize(dir)}${sep}`) || path.startsWith(normalize(dir)),
                'the sanitized name stays inside the root');
            assert.equal(path.split(sep).includes('..'), false, 'no parent-directory segment survives');
            assert.equal(existsSync(join(dir, '.._.._etc_passwd')), true, 'the sanitized file is written inside the root');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('AgentContext.child(): no shared-mutation aliasing', () => {
    it('copies refs/metadata so a child write cannot mutate the parent', () => {
        const parent = new AgentContext({ objective: 'o', refs: { artifact: 'a1' }, metadata: { user: 'u1' } });
        const child = parent.child();
        assert.notEqual(child.refs, parent.refs, 'refs is a copy, not the same object');
        assert.notEqual(child.metadata, parent.metadata, 'metadata is a copy, not the same object');
        assert.deepEqual(child.refs, { artifact: 'a1' });
        const childRefs =  (child.refs);
        const childMeta =  (child.metadata);
        const parentRefs =  (parent.refs);
        const parentMeta =  (parent.metadata);
        childRefs.artifact = 'child-only';
        childMeta.user = 'child';
        assert.equal(parentRefs.artifact, 'a1', 'parent refs untouched');
        assert.equal(parentMeta.user, 'u1', 'parent metadata untouched');

        const childHistory =  (child.objectiveHistory);
        childHistory.push('child-only-goal');
        assert.equal(parent.objectiveHistory.includes('child-only-goal'), false, 'objectiveHistory is a copy');
    });

    it('an explicit override still replaces the parent value', () => {
        const parent = new AgentContext({ objective: 'o', refs: { a: 1 } });
        const child = parent.child({ refs: { b: 2 } });
        assert.deepEqual(child.refs, { b: 2 });
        assert.deepEqual(parent.refs, { a: 1 });
    });
});
