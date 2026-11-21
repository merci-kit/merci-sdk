// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SSEParser, readSSELines } from '../lib/backends/jai-vendor/sse-parser.mjs';
import { ProtocolType } from '../lib/core/constants/index.mjs';
import { createShellTool } from '../lib/tools/shell-tools.mjs';
import { MemoryManager } from '../lib/agentic/memory/manager.mjs';
import { StateMachine } from '../lib/agentic/state-machine/index.mjs';

// ─── D1 residual: stale _timedOut latch ─────────────────────────────────────

describe('D1 residual', () => {
    it('a running step with a stale _timedOut latch re-runs instead of spinning', () => {
        const root = process.cwd();
        const script = `
            const { pathToFileURL } = await import('node:url');
            const { WorkflowExecutor } = await import(pathToFileURL(${JSON.stringify(join(root, 'lib/agentic/planning/executor.mjs'))}).href);
            const { isObjectiveRestatePrompt } = await import(pathToFileURL(${JSON.stringify(join(root, 'lib/agentic/objective.mjs'))}).href);
            const s = { provider: 'openai', withSystemMessage() { return this; }, withTools() { return this; },
                withMemory() { return this; }, withTodos() { return this; }, withParameters() { return this; },
                withObjective() { return this; },
                run: ({ initialInput: i }) => isObjectiveRestatePrompt({ input: i }) ? Promise.resolve('') : Promise.resolve('answer') };
            const ex = new WorkflowExecutor({ options: { client: { session: () => s }, defaultModel: 'm' } });
            ex.setSteps({ stepsList: [{ id: 'a', systemPrompt: 's', userPromptTemplate: 'u', dependencies: [] }] });
            ex.steps.get('a').status = 'running';
            ex.steps.get('a')._timedOut = true;
            const ex2 = WorkflowExecutor.load({ json: ex.save(), options: { client: { session: () => s }, defaultModel: 'm' } });
            const out = await ex2.execute({ userGoal: 'goal' });
            if (out.a?.output !== 'answer') { console.error('unexpected', JSON.stringify(out)); process.exit(1); }
            console.log('DONE');
        `;
        const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 8000, encoding: 'utf8', cwd: root });
        assert.match(out, /DONE/);
    });
});

// ─── J2 residual: clean EOF without a finish marker ─────────────────────────

describe('J2 residual', () => {
    const TOOL_FIRST = { type: 'ToolCall', event_type: 'data', choiceIndex: 0, parallelToolIndex: 0, id: 'fc_1', name: 't' };
    /** @param {{c: *}} arg0 */
    /** @param {{c: *}} arg0 */
    const TOOL_FRAG = ({ c }) => ({ type: 'ToolCall', event_type: 'data', choiceIndex: 0, parallelToolIndex: 0, id: null, name: null, content: c });
    
    /** @param {{events: *}} arg0 */
    async function* feed({ events }) {
        for (const e of events) yield `data: ${JSON.stringify(e)}\n`;
        yield 'data: end\n';
    }

    it('a complete-JSON prefix with no FinishMetadata is not executed', async () => {
        const parser = new SSEParser({ protocol: ProtocolType.CHAT });
        for await (const _ of readSSELines({ stream: feed({ events: [TOOL_FIRST, TOOL_FRAG({ c: '{"a":1}' })] }), parser })) { /* drain */ }
        const { toolCalls } =  (parser.getFinalResult());
        assert.equal(toolCalls.length, 0, 'no finalize signal → no execution');
    });

    it('a finalized call still executes', async () => {
        const parser = new SSEParser({ protocol: ProtocolType.CHAT });
        for await (const _ of readSSELines({ stream: feed({ events: [
            TOOL_FIRST, TOOL_FRAG({ c: '{"a":1}' }),
            { type: 'FinishMetadata', event_type: 'data', reason: 'tool_call' },
        ] }), parser })) { /* drain */ }
        const { toolCalls } =  (parser.getFinalResult());
        assert.equal(toolCalls.length, 1);
    });
});

// ─── T1/T2 residual bypasses ────────────────────────────────────────────────

describe('shell policy residual', () => {
    
    /** @param {Record<string, any>} [opts] */
        /** @param {{opts?: *}} arg0 */
        /** @param {{opts?: *}} arg0 */
        const makeTool = ({ opts = {} } = {}) => {
        let asked = 0;
        const tool =  (
            createShellTool({ options: { approvalCallback: async () => { asked++; return false; }, ...opts } })
        );
        return { tool, asked: () => asked };
    };

    it('man -P (pager command) is gated', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'man', args: ['-P', 'echo', 'ls'] } });
        assert.equal(asked(), 1);
        assert.equal(res.success, false);
    });

    it('an attached --flag=path outside roots is gated', async () => {
        const { tool, asked } = makeTool();
        await tool.execute({ args: { command: 'rg', args: ['--ignore-file=/etc/passwd', 'x', '.'] } });
        assert.equal(asked(), 1);
    });

    it('an attached short -T/path outside roots is gated', async () => {
        const { tool, asked } = makeTool();
        await tool.execute({ args: { command: 'sort', args: ['-T/tmp'] } });
        assert.equal(asked(), 1);
    });

    it('a symlink inside the root pointing outside is gated', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-shell-'));
        try {
            writeFileSync(join(dir, 'inside.txt'), 'ok');
            symlinkSync('/etc/passwd', join(dir, 'link'));
            const { tool, asked } = makeTool({ opts: { roots: [dir], cwd: dir } });
            await tool.execute({ args: { command: 'cat', args: ['link'] } });
            assert.equal(asked(), 1, 'realpath must catch the escape');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a cwd outside the default roots still gates absolute reads', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-shell-cwd-'));
        try {
            const { tool, asked } = makeTool({ opts: { cwd: dir } });
            await tool.execute({ args: { command: 'cat', args: ['/etc/passwd'] } });
            assert.equal(asked(), 1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ─── F1 residual: restored provider-global cursor ───────────────────────────

describe('F1 residual', () => {
    it('a provider with a restored cursor does not make a fresh session skip its turns', async () => {
        const provider = {
            name: 'b', description: 'd', facts:  ([]),
            lastSyncedTurnIndex: 0, restoredSyncIndex: 10,
            async load() {}, async save() {}, async query() { return []; },
            
            /** @param {string} c */
                        async store(c) { const f = { id: `f${this.facts.length}`, content: c }; this.facts.push(/** @type {never} */ (f)); return f; },
            async delete() { return false; },
            getBankDescriptions() { return '- b\n'; },
        };
        const fakeClient = () => ({
            session: () => ({
                withSystemMessage() { return this; },
                withParameters() { return this; },
                run: async () => JSON.stringify({ newFacts: [{ content: 'a fact', category: 'fact', targetBanks: [] }], obsoleteFactIds: [] }),
            }),
        });
        const manager = new MemoryManager({ provider, options: { syncInterval: 1 } });
        const messages = [{ role: 'user', content: 'turn 1' }, { role: 'user', content: 'turn 2' }];
        assert.equal(manager.shouldSync({ messages }), true);
        await manager.distill({ messages, client: fakeClient(), modelToUse: 'm', options: {} });
        assert.equal(provider.facts.length, 1, 'the fresh session distills its own turns');
    });
});

// ─── L1 residual: listener isolation ────────────────────────────────────────

describe('listener isolation', () => {
    it('a throwing completed listener does not reject the run or corrupt phase', async () => {
        const sm = new StateMachine({ graph: {
            entry: 'a',
            nodes: [{ id: 'a', execute: () => 'x', terminal: true }],
            edges: [],
        } });
        sm.on('state_machine:completed', () => { throw new Error('observer bug'); });
        await sm.run();
        assert.equal(sm.phase, 'done');
    });
});
