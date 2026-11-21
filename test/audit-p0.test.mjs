// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgenticLoop } from '../lib/agentic/agentic-core.mjs';
import { ExponentialBackoffPolicy } from '../lib/support/retry-policy.mjs';
import { createUserMessage } from '../lib/messaging/messages.mjs';
import { StateMachine } from '../lib/agentic/state-machine/index.mjs';
import { MemoryManager } from '../lib/agentic/memory/manager.mjs';
import { LocalFileMemoryProvider } from '../lib/agentic/memory/providers.mjs';
import { SSEParser } from '../lib/backends/jai-vendor/sse-parser.mjs';
import { readSSELines } from '../lib/backends/jai-vendor/sse-parser.mjs';
import { ProtocolType } from '../lib/core/constants/index.mjs';
import { executeTools } from '../lib/tools/tool-execution.mjs';
import { createShellTool } from '../lib/tools/shell-tools.mjs';

// ─── D1: DAG resume with a running step ─────────────────────────────────────

describe('D1: DAG resume invariant', () => {
    it('loading a checkpoint with a running step terminates and re-runs it', () => {
        const root = process.cwd();
        const script = `
            const { pathToFileURL } = await import('node:url');
            const { WorkflowExecutor } = await import(pathToFileURL(${JSON.stringify(join(root, 'lib/agentic/planning/executor.mjs'))}).href);
            const { isObjectiveRestatePrompt } = await import(pathToFileURL(${JSON.stringify(join(root, 'lib/agentic/objective.mjs'))}).href);
            const fakeSession = {
                provider: 'openai',
                withSystemMessage() { return this; }, withTools() { return this; },
                withMemory() { return this; }, withTodos() { return this; },
                withParameters() { return this; }, withObjective() { return this; },
                run: ({ initialInput }) => isObjectiveRestatePrompt({ input: initialInput }) ? Promise.resolve('') : Promise.resolve('answer'),
            };
            const client = { session: () => fakeSession };
            const step = { id: 'a', title: 'A', systemPrompt: 's', userPromptTemplate: 'u', dependencies: [] };
            const ex = new WorkflowExecutor({ options: { client, defaultModel: 'm' } });
            ex.setSteps({ stepsList: [step] });
            ex.steps.get('a').status = 'running';
            const ex2 = WorkflowExecutor.load({ json: ex.save(), options: { client, defaultModel: 'm' } });
            const out = await ex2.execute({ userGoal: 'goal' });
            if (out.a?.output !== 'answer') { console.error('unexpected output', JSON.stringify(out)); process.exit(1); }
            console.log('DONE');
        `;
        const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            timeout: 8000,
            encoding: 'utf8',
            cwd: root,
        });
        assert.match(out, /DONE/);
    });
});

// ─── C1: run-scoped retry restart point ─────────────────────────────────────

/** @param {{id: any, content: any}} arg0 */
/** @param {{id: *, content: *}} arg0 */
const TOOL_ROW = ({ id, content }) => ({
    role: 'tool', tool_call_id: id, name: 'read', content,
});

/** @param {{script: any[]}} arg0 */
function makeSession({ script }) {
    /** @type {any[]} */
    const stepCalls = [];
    let calls = 0;
    /** @type {any} */
    const session = {
        provider: 'OAI',
        model: 'test-model',
        _tools: [],
        _retryPolicy: undefined,
        eventEmitter: { emit: () => {} },
        stepCalls,
        /** @param {{messages: any[]}} arg0 */
        async *step({ messages }) {
            stepCalls.push(messages.map((/** @type {any} */ m) => ({ ...m })));
            const outcome = script[calls++];
            if (outcome instanceof Function) return outcome(messages);
            throw outcome;
        },
    };
    return session;
}

describe('C1: run-scoped restart point', () => {
    it("another run's committed state is never the restart point", async () => {
        const session = makeSession({ script: [
            (/** @type {any} */ m) => {
                const history = [...m, TOOL_ROW({ id: 'r1', content: 'R1-step' })];
                session._lastStepMessages = history;
                return { done: false, messages: history, thoughtSignature: null };
            },
            (/** @type {any} */ m) => {
                session._lastStepMessages = [...m, TOOL_ROW({ id: 'r2', content: 'R2-other-run' })];
                throw Object.assign(new Error('vendor exploded mid-run'), { status: 500 });
            },
            (/** @type {any} */ m) => ({ done: true, content: 'final answer', messages: m, thoughtSignature: null }),
        ] });

        const answer = await runAgenticLoop({ session, messages: [createUserMessage({ provider: 'OAI', content: 'hi' })], opts: {
            retryPolicy: new ExponentialBackoffPolicy({ maxRetries: 1, initialDelayMs: 1, maxDelayMs: 2, jitterMs: 0 }),
        } });

        assert.equal(answer, 'final answer');
        assert.ok(session.stepCalls[2].some((/** @type {any} */ m) => m.tool_call_id === 'r1'),
            "the retry must resume from THIS run's last committed boundary");
        assert.ok(!session.stepCalls[2].some((/** @type {any} */ m) => m.tool_call_id === 'r2'),
            "another run's state must never seed the restart");
    });
});

// ─── S1: SM completion gate phase ───────────────────────────────────────────

describe('S1: SM gate failure honesty', () => {
    it('a throwing completion gate leaves phase error, not done', async () => {
        const sm = new StateMachine({ graph: {
            entry: 'a',
            nodes: [{ id: 'a', execute: () => 'x', terminal: true }],
            edges: [],
        } });
        await assert.rejects(
            () => sm.run({ contract: { criteria: [{ name: 'boom', check: () => { throw new Error('boom'); } }] } }),
            /boom/,
        );
        assert.equal(sm.phase, 'error', 'a failed gate must never report done');
    });
});

// ─── F1: memory distill cursor scoping ──────────────────────────────────────

describe('F1: memory distill cursor', () => {
    it('a fresh session over a shared provider still distills its own turns', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-audit-p0-'));
        try {
            const provider = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'm.json') } });
            const fakeClient = () => ({
                session: () => ({
                    withSystemMessage() { return this; },
                    withParameters() { return this; },
                    run: async () => '{"newFacts":[{"content":"a fact","category":"fact","targetBanks":[]}],"obsoleteFactIds":[]}',
                }),
            });
            const managerA = new MemoryManager({ provider, options: { syncInterval: 1 } });
            await managerA.distill({ messages: [{ role: 'user', content: 'step 1' }], client: fakeClient(), modelToUse: 'm', options: {} });

            const managerB = new MemoryManager({ provider, options: { syncInterval: 1 } });
            assert.equal(managerB.shouldSync({ messages: [{ role: 'user', content: 'step 2' }] }), true,
                'a fresh session must not inherit another session\'s turn cursor');
            await managerB.distill({ messages: [{ role: 'user', content: 'step 2' }], client: fakeClient(), modelToUse: 'm', options: {} });
            assert.equal(provider.facts.length, 2, "both sessions' turns must reach the bank");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ─── J2: non-finalizing FinishMetadata ──────────────────────────────────────

describe('J2: truncated tool calls', () => {
    const TOOL_FIRST = { type: 'ToolCall', event_type: 'data', choiceIndex: 0, parallelToolIndex: 0, id: 'fc_1', name: 'get_weather' };
    /** @param {{c: any}} arg0 */
    /** @param {{c: *}} arg0 */
    const TOOL_FRAG = ({ c }) => ({ type: 'ToolCall', event_type: 'data', choiceIndex: 0, parallelToolIndex: 0, id: null, name: null, content: c });
    /** @param {{events: Array<Record<string, any>>}} arg0 */
    async function* feed({ events }) {
        for (const e of events) yield `data: ${JSON.stringify(e)}\n`;
        yield 'data: end\n';
    }

    for (const reason of ['unknown', 'error', 'safety', 'cancelled']) {
        it(`reason '${reason}' never sweeps truncated args into execution`, async () => {
            const parser = new SSEParser({ protocol: ProtocolType.CHAT });
            for await (const _ of readSSELines({ stream: feed({ events: [
                TOOL_FIRST, TOOL_FRAG({ c: '{"city":"Par' }),
                { type: 'FinishMetadata', event_type: 'data', reason },
            ] }), parser })) { /* drain */ }
            const { toolCalls } = /** @type {any} */ (parser.getFinalResult());
            assert.equal(toolCalls.length, 0, `reason '${reason}' must not finalize a partial call`);
        });
    }

    it('a complete call finalized by tool_call still executes', async () => {
        const parser = new SSEParser({ protocol: ProtocolType.CHAT });
        for await (const _ of readSSELines({ stream: feed({ events: [
            TOOL_FIRST, TOOL_FRAG({ c: '{"city":"Paris"}' }),
            { type: 'FinishMetadata', event_type: 'data', reason: 'tool_call' },
        ] }), parser })) { /* drain */ }
        const { toolCalls } = /** @type {any} */ (parser.getFinalResult());
        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].arguments, '{"city":"Paris"}');
    });
});

// ─── T10: tool without execute ──────────────────────────────────────────────

describe('T10: tool without execute', () => {
    it('is a failed result, not a silent success', async () => {
        const tool = {
            name: 'noop',
            parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
            requiresApproval: true,
        };
        let asked = 0;
        const [res] = /** @type {Array<any>} */ (await executeTools({ toolCalls: [{ id: 'c1', name: 'noop', arguments: '{}' }], toolLibrary: [tool], signal: undefined, approval: { callback: async () => { asked++; return true; } }, emitter: new EventEmitter() }));
        assert.equal(res.success, false, 'a tool with no execute must not fabricate success');
        assert.equal(asked, 0, 'no approval for a tool that cannot run');
    });
});

// ─── T1/T2: shell safe tier ─────────────────────────────────────────────────

describe('shell safe tier capability policy', () => {
    it('T1: `rg --pre` is an execution vector and must hit the gate', async () => {
        let asked = 0;
        const tool = /** @type {any} */ (
            createShellTool({ options: { approvalCallback: async () => { asked++; return false; } } })
        );
        const res = await tool.execute({ args: { command: 'rg', args: ['--pre', 'echo', 'x', 'test/audit-p0.test.mjs'] } });
        assert.equal(asked, 1, 'a preprocessor-launching rg invocation is not read-only');
        assert.equal(res.success, false, 'denied by the gate');
    });

    it('T2: reading outside the roots must hit the gate', async () => {
        let asked = 0;
        const tool = /** @type {any} */ (
            createShellTool({ options: { approvalCallback: async () => { asked++; return false; } } })
        );
        const res = await tool.execute({ args: { command: 'cat', args: ['/etc/passwd'] } });
        assert.equal(asked, 1, 'host filesystem reads are gated');
        assert.equal(res.success, false, 'denied by the gate');
    });
});
