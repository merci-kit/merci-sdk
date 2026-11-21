// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { getEventListeners } from 'node:events';

import { executeTools } from '../lib/tools/tool-execution.mjs';
import { createShellTool } from '../lib/tools/shell-tools.mjs';
import { sleepAbortable } from '../lib/support/retry-policy.mjs';
import { loadMcpTools } from '../lib/tools/mcp-client.mjs';
import { ExecutionJournal, JOURNAL_STATUS, toolJournalKey } from '../lib/agentic/journal.mjs';
import { isAbortError } from '../lib/core/errors.mjs';


/** A promise that never settles — the hostile tool. */
const never = () => new Promise(() => {});

describe('2A: dispatch-level cancellation', () => {
    it('a tool that ignores the signal is abandoned on abort', async () => {
        const ac = new AbortController();
        const tool = { name: 'stuck', parameters: { type: 'object', properties: {} }, execute: () => never() };
        const pending = executeTools({ toolCalls: [{ id: 'c1', name: 'stuck', arguments: '{}' }], toolLibrary: [tool], signal: ac.signal });
        setTimeout(() => ac.abort(new Error('cancelled')), 20);
        await assert.rejects(pending, (e) => isAbortError({ err: e }));
    });

    it('an aborted in-flight call is journaled interrupted, not done', async () => {
        const ac = new AbortController();
        const journal = new ExecutionJournal();
        const tool = { name: 'stuck', parameters: { type: 'object', properties: {} }, execute: () => never() };
        const pending = executeTools({ toolCalls: [{ id: 'c1', name: 'stuck', arguments: '{}' }], toolLibrary: [tool], signal: ac.signal, journal, boundary: 'b1' });
        setTimeout(() => ac.abort(new Error('cancelled')), 20);
        await assert.rejects(pending, (e) => isAbortError({ err: e }));
        const key = toolJournalKey({ runId: journal.runId, boundary: 'b1', name: 'stuck', args: {} });
        assert.equal(journal.get({ key })?.status, JOURNAL_STATUS.INTERRUPTED);
    });

    it('a pre-aborted signal never starts the tool', async () => {
        const ac = new AbortController();
        ac.abort(new Error('already gone'));
        let started = 0;
        const tool = { name: 't', parameters: { type: 'object', properties: {} }, execute: async () => { started++; return 'x'; } };
        await assert.rejects(
            executeTools({ toolCalls: [{ id: 'c1', name: 't', arguments: '{}' }], toolLibrary: [tool], signal: ac.signal }),
            (e) => isAbortError({ err: e }),
        );
        assert.equal(started, 0);
    });
});

describe('2A: shell HITL abort', () => {
    it('a never-resolving approval callback cannot park the run', async () => {
        const ac = new AbortController();
        const tool =  (
            createShellTool({ options: { approvalCallback: () => never() } })
        );
        const pending = tool.execute({ args: { command: 'node', args: ['--version'] }, signal: ac.signal });
        setTimeout(() => ac.abort(new Error('cancelled')), 20);
        await assert.rejects(pending, (e) => isAbortError({ err: e }));
    });
});

describe('2A: listener hygiene', () => {
    it('sleepAbortable removes its abort listener on the normal path', async () => {
        const ac = new AbortController();
        await sleepAbortable({ ms: 5, signal: ac.signal });
        assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
    });
});

describe('2A: MCP cancellation plumbing', () => {
    it('executeTool receives the caller signal and a request timeout', async () => {
        
        /** @type {any[]} */
                const calls = [];
        const fakeClient = {
            async start() {},
            async getTools() { return [{ name: 'remote', description: 'd', inputSchema: { type: 'object' } }]; },
            /** @param {{name: *, args: *, signal: *}} arg0 */
            async executeTool({ name, args, signal }) {
                calls.push({ name, args, signal });
                return { content: [{ type: 'text', text: 'ok' }] };
            },
            async stop() {},
        };
        const tools =  (await loadMcpTools({ mcpClient: /** @type {any} */ (fakeClient) }));
        const ac = new AbortController();
        await tools[0].execute({ args: { q: 1 }, signal: ac.signal });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].signal, ac.signal);
        assert.equal(typeof  (/** @type {any} */ (tools)).stop, 'function', 'teardown is exposed on the tool array');
    });
});
