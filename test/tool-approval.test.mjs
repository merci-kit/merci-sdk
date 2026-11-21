// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { executeTools, mapToolsToConfig } from '../lib/tools/tool-execution.mjs';
import { drainStepWithHooks } from '../lib/agentic/agentic-core.mjs';
import { ChatSessionBuilder } from '../lib/agentic/chat-session-builder.mjs';
import { EVENTS, RunContext } from '../lib/core/events.mjs';
import { isAbortError } from '../lib/core/errors.mjs';

/** @param {{options?: *}} arg0 */
const gatedTool = ({ options = {} } = {}) => ({
    name: 'gated',
    description: 'a mutating tool',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    execute: async () => 'ran',
    ...options
});

/** @param {{ms: *}} arg0 */
const sleep = ({ ms }) => new Promise((r) => setTimeout(r, ms));

describe('executeTools generic approval gate', () => {
    it('gates a marked tool until the approval callback approves', async () => {
        let executed = 0;
        let asked = 0;
        const tool = gatedTool({ options: { execute: async () => { executed++; return { ok: true }; } } });
        const approval = { callback: /** @type {(...args: any[]) => any} */ (async ( name,  args,  ctx) => {
            assert.equal(name, 'gated');
            assert.deepEqual(args, {});
            assert.equal(ctx.tool, tool);
            asked++;
            return true;
        }) };
        const [res] =  (await executeTools({ toolCalls: [{ id: 'c1', name: 'gated', arguments: '{}' }], toolLibrary: [tool], signal: null, approval }));
        assert.equal(asked, 1);
        assert.equal(executed, 1);
        assert.equal(/** @type {any} */ (res).success, true);
        assert.deepEqual(/** @type {any} */ (res).result, { ok: true });
    });

    it('denies when the callback declines and never executes the tool', async () => {
        let executed = 0;
        const tool = gatedTool({ options: { execute: async () => { executed++; } } });
        const [res] =  (await executeTools({ toolCalls: [{ id: 'c1', name: 'gated', arguments: '{}' }], toolLibrary: [tool], signal: null, approval: { callback: () => false } }));
        assert.equal(executed, 0);
        assert.equal(/** @type {any} */ (res).success, false);
        assert.match(/** @type {any} */ (res).error, /denied/i);
    });

    it('honors a per-args requiresApproval predicate', async () => {
        /** @type {any[]} */
        const asked =  ([]);
        const tool = gatedTool({ options: {
            /** @param {{args: *}} arg0 */
            requiresApproval: ({ args }) => args.danger === true,
            execute: async () => 'done'
        } });
        const approval = { callback: /** @type {(...args: any[]) => any} */ (( name,  args) => { asked.push(args); return true; }) };
        const results =  (await executeTools({ toolCalls: [
            { id: 'c1', name: 'gated', arguments: JSON.stringify({ danger: false }) },
            { id: 'c2', name: 'gated', arguments: JSON.stringify({ danger: true }) }
        ], toolLibrary: [tool], signal: null, approval }));
        assert.equal(asked.length, 1, 'only the dangerous call is gated');
        assert.deepEqual(asked[0], { danger: true });
        assert.ok(results.every((r) => /** @type {any} */ (r).success));
    });

    it('fails closed when a gated tool has no approval handler', async () => {
        let executed = 0;
        const tool = gatedTool({ options: { execute: async () => { executed++; } } });
        const [res] =  (await executeTools({ toolCalls: [{ id: 'c1', name: 'gated', arguments: '{}' }], toolLibrary: [tool] }));
        assert.equal(executed, 0);
        assert.equal(/** @type {any} */ (res).success, false);
        assert.match(/** @type {any} */ (res).error, /no approval handler/i);
    });

    it('times out like ApprovalCoordinator; a late approval never runs the tool', async () => {
        let executed = 0;
        let release;
        const late = new Promise((r) => { release = r; });
        const tool = gatedTool({ options: { execute: async () => { executed++; } } });
        const [res] =  (await executeTools({ toolCalls: [{ id: 'c1', name: 'gated', arguments: '{}' }], toolLibrary: [tool], signal: null, approval: { callback: () => late, timeoutMs: 20 } }));
        assert.equal(/** @type {any} */ (res).success, false);
        assert.match(/** @type {any} */ (res).error, /timed out/i);
         /** @type {any} */
                  (release)(true);
        await sleep({ ms: 10 });
        assert.equal(executed, 0, 'the late approval must not execute the tool');
    });

    it('aborts the wait with AbortError (cancellation, not a tool failure)', async () => {
        const ac = new AbortController();
        const tool = gatedTool();
        const pending = executeTools({ toolCalls: [{ id: 'c1', name: 'gated', arguments: '{}' }], toolLibrary: [tool], signal: ac.signal, approval: { callback: () => new Promise(() => {}), timeoutMs: 5000 } });
        await sleep({ ms: 10 });
        ac.abort(new Error('cancel'));
        await assert.rejects(pending, ( e) => isAbortError({ err: e }));
    });

    it('never consults the callback for a tool that does not require approval', async () => {
        let asked = 0;
        let executed = 0;
        const tool = {
            name: 'plain',
            parameters: { type: 'object', properties: {} },
            execute: async () => { executed++; return 'ok'; }
        };
        const [res] =  (await executeTools({ toolCalls: [{ id: 'c1', name: 'plain', arguments: '{}' }], toolLibrary: [tool], signal: null, approval: { callback: () => { asked++; return true; } } }));
        assert.equal(asked, 0);
        assert.equal(executed, 1);
        assert.equal(/** @type {any} */ (res).success, true);
    });

    it('emits tool:approval_requested / granted / denied', async () => {
        const emitter = new EventEmitter();
        const runContext = new RunContext();
        /** @type {any[]} */
        const seen =  ([]);
        for (const n of [EVENTS.TOOL.APPROVAL_REQUESTED, EVENTS.TOOL.APPROVAL_GRANTED, EVENTS.TOOL.APPROVAL_DENIED]) {
            emitter.on(n, (e) => seen.push(e.event));
        }
        await executeTools({ toolCalls: [{ id: 'c1', name: 'gated', arguments: '{}' }], toolLibrary: [gatedTool()], signal: null, emitter, runContext, approval: { callback: () => true } });
        await executeTools({ toolCalls: [{ id: 'c2', name: 'gated', arguments: '{}' }], toolLibrary: [gatedTool()], signal: null, emitter, runContext, approval: { callback: () => false } });
        assert.deepEqual(seen, [
            EVENTS.TOOL.APPROVAL_REQUESTED, EVENTS.TOOL.APPROVAL_GRANTED,
            EVENTS.TOOL.APPROVAL_REQUESTED, EVENTS.TOOL.APPROVAL_DENIED
        ]);
    });
});

describe('mapToolsToConfig strips runtime-only fields', () => {
    it('keeps only name/description/parameters on the wire', () => {
        const [config] =  (mapToolsToConfig({ tools: [{
            name: 'x',
            description: 'd',
            parameters: { type: 'object', properties: {} },
            instructions: 'internal',
            requiresApproval: true,
            execute: () => {}
        }] }));
        assert.deepEqual(Object.keys(config).sort(), ['description', 'name', 'parameters']);
        assert.equal(/** @type {any} */ (config).requiresApproval, undefined);
        assert.equal(/** @type {any} */ (config).execute, undefined);
        assert.equal(/** @type {any} */ (config).instructions, undefined);
        assert.deepEqual(/** @type {any} */ (config).parameters, { schema: { type: 'object', properties: {} } });
    });
});

describe('approval threading', () => {
    it('drainStepWithHooks threads the approval policy into executeTools', async () => {
        let executed = 0;
        let asked = 0;
        const tools = [gatedTool({ options: { execute: async () => { executed++; return 'pong'; } } })];
        
        /**
         * @returns {AsyncGenerator<any, any, any>}
         */
                async function* gen() {
            yield { type: 'tool_request', calls: [{ id: 'c1', name: 'gated', args: '{}' }] };
            const results = yield;
            return { done: false, messages: [{ role: 'assistant', tool_calls: results }] };
        }
        await drainStepWithHooks({ gen: gen(), tools, approval: { callback: () => { asked++; return true; } } });
        assert.equal(asked, 1);
        assert.equal(executed, 1);
    });

    it('ChatSessionBuilder.withApproval stores the policy and chains', () => {
        const builder = new ChatSessionBuilder();
        const fn = () => true;
        assert.equal(builder.withApproval({ fn }), builder);
        assert.equal( (/** @type {any} */ (builder._approvalPolicy)).callback, fn);
        assert.equal( (/** @type {any} */ (builder.withApproval({ fn, options: { timeoutMs: 1234 } })))._approvalPolicy.timeoutMs, 1234);
        assert.equal( (builder.withApproval({ fn: null }))._approvalPolicy, null);
    });
});
