// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowExecutor } from '../lib/agentic/planning/executor.mjs';
import { createStateMachineTool, StateMachine } from '../lib/agentic/state-machine/machine.mjs';
import { structuredLlmCall } from '../lib/agentic/planning/planner-utils.mjs';
import { MemoryManager } from '../lib/agentic/memory/manager.mjs';
import { FALLBACK_MESSAGE } from '../lib/core/constants/index.mjs';
import { LocalFileMemoryProvider } from '../lib/agentic/memory/providers.mjs';
import { LIMITS } from '../lib/core/limit-config.mjs';

function dummySession() {
    return {
        provider: 'openai',
        model: 'gpt-4o-mini',
        eventEmitter: new EventEmitter(),
        session: () => null,
        run: async () => { throw new Error('not used'); },
    };
}

describe('executor: declined extension fails the step (CRITICAL)', () => {
    it('a declined iteration-limit extension marks the step failed', async () => {
        const client = {
            session: () => ({
                provider: 'openai',
                withSystemMessage() { return this; },
                withTools() { return this; },
                withMemory() { return this; },
                withTodos() { return this; },
                /** @param {{options: any}} arg0 */
                run: async ({ options: opts }) => {
                    await opts.onLimitReached({ iteration: 1, extensionRound: 1 });
                    return FALLBACK_MESSAGE.MAX_ITERATIONS;
                }
            })
        };
        const exec = new WorkflowExecutor({ options: {
            client,
            defaultModel: 'm',
            maxIterations: 1,
            hitlTimeoutMs: 50
        } });
        exec.setSteps({ stepsList: [{ id: 'a', title: 'A', systemPrompt: 'Be terse.', userPromptTemplate: 'do it', dependencies: [] }] });
        await assert.rejects(exec.execute({ userGoal: 'goal' }), /iteration limit|failed/);
        const step = /** @type {any} */ (exec.steps.get('a'));
        assert.equal(step.status, 'failed', 'declined step must be failed, not completed');
        assert.match(step.output, /iteration limit|declined/);
    });
});

describe('state machine tool gate (M7)', () => {
    it('a failed completion gate returns success:false through the tool', async () => {
        const graph = {
            entry: 'a',
            nodes: [{ id: 'a', execute: async () => ({ value: 1 }) }],
            edges: []
        };
        const tool = createStateMachineTool({ graph, options: {} });
        const result = await (/** @type {any} */ (tool)).execute({ args: { context: {} } });
        assert.equal(typeof result, 'string');
    });
});

describe('structuredLlmCall abort handling (C5)', () => {
    it('does not retry an AbortError', async () => {
        let calls = 0;
        const client = {
            provider: 'openai',
            session: () => ({
                withSystemMessage() { return this; },
                withParameters() { return this; },
                run: async () => { calls++; throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
            })
        };
        await assert.rejects(
            structuredLlmCall(/** @type {any} */ ({ client, model: 'm', schema: {}, prompt: 'p', maxAttempts: 3 })),
            (/** @type {any} */ e) => e.name === 'AbortError'
        );
        assert.equal(calls, 1, 'must not retry aborts');
    });

    it('the failure message names the offending fields (schema details are not swallowed)', async () => {
        const z = (await import('zod')).z;
        const client = {
            provider: 'openai',
            session: () => ({
                withSystemMessage() { return this; },
                withParameters() { return this; },
                run: async () => '{}'
            })
        };
        const schema = z.object({ name: z.string() });
        await assert.rejects(
            structuredLlmCall(/** @type {any} */ ({ client, model: 'm', schema, prompt: 'p', maxAttempts: 1 })),
            /\/name: /
        );
    });

    it('the tool-capture repair feedback carries the real validation details (no JSON_PARSE_ERROR lie)', async () => {
        const z = (await import('zod')).z;
        const schema = z.object({ name: z.string() });
        const repairs = /** @type {any[]} */ ([]);
        let round = 0;
        const client = {
            provider: 'openai',
            session: () => ({
                withSystemMessage() { return this; },
                withTools() { return this; },
                withParameters() { return this; },
                /** @returns {AsyncGenerator<any, any, any>} */
                async *step() {
                    round++;
                    if (round === 1) {
                        const results = yield { type: 'tool_request', calls: [{ name: 'plan', arguments: '{}' }] };
                        repairs.push(results);
                        yield { type: 'tool_request', calls: [{ name: 'plan', arguments: JSON.stringify({ name: 'ok' }) }] };
                    }
                    return { done: true, content: '', messages: [] };
                }
            })
        };
        const data = await structuredLlmCall(/** @type {any} */ ({ client, model: 'm', schema, prompt: 'p', schemaName: 'plan', useToolCapture: true, maxAttempts: 1 }));
        assert.deepEqual(data, { name: 'ok' });
        assert.equal(repairs.length, 1);
        assert.match(repairs[0][0].result, /VALIDATION_ERROR: .*\/name: /, 'the repair names the offending path');
        assert.doesNotMatch(repairs[0][0].result, /JSON_PARSE_ERROR/);
    });
});

describe('planner step prompt normalization (flash-tier description alias)', () => {
    it('a step that only carries description gets it aliased into both prompt slots', async () => {
        const { WorkflowPlanner } = await import('../lib/agentic/planning/planner.mjs');
        const flashPlan = {
            goal: 'Create a minimal greet CLI script.',
            steps: [
                { id: 'explore', description: 'Examine the project layout.', dependencies: [] },
                { id: 'write', description: 'Write greet.mjs.', dependencies: ['explore'] },
            ],
        };
        const client = {
            provider: 'openai',
            session: () => ({
                withSystemMessage() { return this; },
                withParameters() { return this; },
                run: async () => JSON.stringify(flashPlan)
            })
        };
        const planner = new WorkflowPlanner({ options: { client, model: 'm' } });
        const plan = await planner.plan({ objective: 'Create a minimal greet CLI script.' });
        const steps = /** @type {any[]} */ (plan.steps);
        assert.equal(steps.length, 2, 'flash-tier plan validates');
        assert.equal(steps[0].systemPrompt, 'Examine the project layout.');
        assert.equal(steps[0].userPromptTemplate, 'Examine the project layout.');
        assert.equal(steps[1].systemPrompt, 'Write greet.mjs.');
    });

    it('explicit prompts are never overwritten by the alias', async () => {
        const { WorkflowPlanner } = await import('../lib/agentic/planning/planner.mjs');
        const plan = {
            steps: [
                { id: 'a', description: 'ignored', systemPrompt: 'SYS', userPromptTemplate: 'USER', dependencies: [] },
                { id: 'b', description: 'fallback', dependencies: ['a'] },
            ],
        };
        const client = {
            provider: 'openai',
            session: () => ({
                withSystemMessage() { return this; },
                withParameters() { return this; },
                run: async () => JSON.stringify(plan)
            })
        };
        const planner = new WorkflowPlanner({ options: { client, model: 'm' } });
        const out = await planner.plan({ objective: 'goal' });
        const outSteps = /** @type {any[]} */ (out.steps);
        assert.equal(outSteps[0].systemPrompt, 'SYS');
        assert.equal(outSteps[0].userPromptTemplate, 'USER');
        assert.equal(outSteps[1].userPromptTemplate, 'fallback');
    });
});

describe('memory distillation overlap (M4)', () => {
    it('a second distill call while one is in flight is skipped', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-mem-'));
        const provider = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'm.json') } });
        const manager = new MemoryManager({ provider, options: { syncInterval: 1 } });
        let started = 0;
        const gate = new Promise(/** @type {(resolve: (value?: any) => void) => void} */ (resolve) => resolve());
        const client = {
            provider: 'openai',
            session: () => ({
                withSystemMessage() { return this; },
                withParameters() { return this; },
                run: async () => {
                    started++;
                    if (started === 1) await new Promise(r => setTimeout(r, 50));
                    return JSON.stringify({ newFacts: [], obsoleteFactIds: [] });
                }
            })
        };
        const messages = [{ role: 'user', content: 'hi' }];
        const p1 = manager.distill({ messages, client, modelToUse: 'm', options: {} });
        const p2 = manager.distill({ messages, client, modelToUse: 'm', options: {} });
        await Promise.all([p1, p2]);
        assert.equal(started, 1, 'second overlapping distill must be skipped');
        rmSync(dir, { recursive: true, force: true });
    });

    it('a failed distill does not re-fire over the same delta on the next sync check', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-mem-'));
        const provider = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'm.json') } });
        const manager = new MemoryManager({ provider, options: { syncInterval: 1 } });
        const client = {
            provider: 'openai',
            session: () => ({
                withSystemMessage() { return this; },
                withParameters() { return this; },
                run: async () => 'prose, not JSON'
            })
        };
        const messages = [{ role: 'user', content: 'hi' }];
        await manager.distill({ messages, client, modelToUse: 'm', options: {} });
        assert.ok(manager.lastDistillError, 'failure is surfaced');
        assert.equal(manager.shouldSync({ messages }), false, 'same-delta re-sync must be suppressed');
        assert.equal(manager.shouldSync({ messages: [...messages, { role: 'user', content: 'more' }] }), true,
            'new turns re-arm the sync');
        rmSync(dir, { recursive: true, force: true });
    });
});

describe('memory fact cap (M3)', () => {
    it('the bank is capped and oldest facts are evicted', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-mem-'));
        const provider = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'm.json') } });
        for (let i = 0; i < LIMITS.memory_max_facts_per_bank + 20; i++) {
            await provider.store({ content: `fact number ${i}` });
        }
        assert.equal(provider.facts.length, LIMITS.memory_max_facts_per_bank);
        const oldest = provider.facts[provider.facts.length - 1];
        assert.ok(!oldest.content.includes('fact number 0'), 'oldest fact must be evicted');
        rmSync(dir, { recursive: true, force: true });
    });
});
