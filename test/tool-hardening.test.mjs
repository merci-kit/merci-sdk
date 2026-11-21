// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { createShellTool } from '../lib/tools/shell-tools.mjs';
import { SHELL_TOOL_DEFAULT_SAFE_COMMANDS } from '../lib/core/constants/index.mjs';
import { executeTools } from '../lib/tools/tool-execution.mjs';
import { runCommand } from '../lib/support/run-command.mjs';
import { isAbortError } from '../lib/core/errors.mjs';
import { EVENTS, RunContext } from '../lib/core/events.mjs';
import { createHooks, HOOKS } from '../lib/core/hooks.mjs';
import { ExecutionJournal, toolJournalKey } from '../lib/agentic/journal.mjs';

describe('shell safelist (C1)', () => {
    const HITL_GATED = [
        'node', 'npx', 'python3', 'ruby', 'perl', 'git', 'find', 'sed', 'tee',
        'hg', 'svn', 'awk', 'gawk', 'xattr', 'mdimport', 'stty'
    ];
    it('interpreters, git, find, sed, tee, awk are no longer safe (HITL-gated)', () => {
        for (const cmd of HITL_GATED) {
            assert.ok(!SHELL_TOOL_DEFAULT_SAFE_COMMANDS.includes(cmd), `${cmd} must not be on the safe list`);
        }
    });
    it('read-only inspectors stay safe', () => {
        for (const cmd of ['ls', 'cat', 'pwd', 'grep', 'wc']) {
            assert.ok(SHELL_TOOL_DEFAULT_SAFE_COMMANDS.includes(cmd), `${cmd} must stay safe`);
        }
    });
    it('a HITL-gated command prompts the user', async () => {
        let asked = false;
        const tool =  (createShellTool({ options: { approvalCallback: async () => { asked = true; return true; } } }));
        const res = await tool.execute({ args: { command: 'node', args: ['--version'] } });
        assert.ok(asked, 'node must go through approval');
        assert.equal(res.success, true);
    });
    it('a blocked command is rejected without HITL', async () => {
        let asked = false;
        const tool =  (createShellTool({ options: { approvalCallback: async () => { asked = true; return true; } } }));
        const res = await tool.execute({ args: { command: 'rm', args: ['-rf', '/'] } });
        assert.ok(!asked, 'blocklist must reject before approval');
        assert.equal(res.success, false);
    });
});

describe('executeTools error channel (M1/M2)', () => {
    it('a returned { success:false } becomes a FAILED result, not success:true', async () => {
        const tool = { name: 'flaky', execute: async () => ({ success: false, error: 'boom' }) };
        const [res] =  (await executeTools({ toolCalls: [{ id: 'c1', name: 'flaky', arguments: '{}' }], toolLibrary: [tool] }));
        assert.equal(/** @type {any} */ (res).success, false);
        assert.equal(/** @type {any} */ (res).error, 'boom');
    });

    it('AbortError propagates instead of becoming a tool failure', async () => {
        const ac = new AbortController();
        const tool = {
            name: 'slow',
            /** @param {{signal: *}} arg0 */
            execute: async ({ signal }) => new Promise((_, reject) => {
                const err = Object.assign(new Error('cancelled'), { name: 'AbortError' });
                if (signal?.aborted) return reject(err);
                signal?.addEventListener('abort', () => reject(err), { once: true });
            })
        };
        const pending = executeTools({ toolCalls: [{ id: 'c1', name: 'slow', arguments: '{}' }], toolLibrary: [tool], signal: ac.signal });
        ac.abort(new Error('cancelled'));
        await assert.rejects(pending, (e) => isAbortError({ err: e }));
    });

    it('wire arguments are parsed strictly: a truncated call is a repair round, never healed into execution', async () => {
        let executed = 0;
        const tool = {
            name: 'write_file',
            parameters: {
                type: 'object',
                properties: { path: { type: 'string' }, content: { type: 'string' } },
                required: ['path', 'content'],
            },
            execute: async () => { executed++; return 'ok'; },
        };
        const [res] =  (await executeTools({ toolCalls: [{ id: 'c1', name: 'write_file', arguments: '{"path":"/tmp/x","content":"partial' }], toolLibrary: [tool] }));
        assert.equal(/** @type {any} */ (res).success, false);
        assert.match(/** @type {any} */ (res).error, /Invalid tool arguments/);
        assert.equal(executed, 0, 'the truncated call must never run');
    });
});

describe('tool round events pair (G1-6)', () => {
    /** @param {EventEmitter} emitter */
    function record(emitter) {
        /** @type {any[]} */
        const events = [];
        for (const name of [EVENTS.TOOL.ROUND_START, EVENTS.TOOL.CALL_START, EVENTS.TOOL.CALL_END, EVENTS.TOOL.ROUND_END]) {
            emitter.on(name, (event) => events.push(event));
        }
        return events;
    }

    it('an aborted tool round pairs its events', async () => {
        const emitter = new EventEmitter();
        const events = record(emitter);
        const ac = new AbortController();
        const tool = {
            name: 'slow',
            parameters: { type: 'object', properties: {} },
            execute: async (/** @type {{signal: *}} */ { signal }) => new Promise((_, reject) => {
                const err = Object.assign(new Error('cancelled'), { name: 'AbortError' });
                if (signal?.aborted) return reject(err);
                signal?.addEventListener('abort', () => reject(err), { once: true });
            })
        };
        const runContext = new RunContext({ runId: 'r1' });
        const pending = executeTools({ toolCalls: [{ id: 'c1', name: 'slow', arguments: '{}' }], toolLibrary: [tool], signal: ac.signal, emitter, runContext });
        await new Promise((resolve) => setTimeout(resolve, 5));
        ac.abort(new Error('cancelled'));
        await assert.rejects(pending, (e) => isAbortError({ err: e }));

        assert.deepEqual(events.map((e) => e.event), [
            EVENTS.TOOL.ROUND_START, EVENTS.TOOL.CALL_START, EVENTS.TOOL.CALL_END, EVENTS.TOOL.ROUND_END
        ]);
        assert.equal(events[2].aborted, true, 'the call end says it was an abort');
        assert.equal(events[3].count, 1, 'the round closes once');
    });

    it('an interrupted replay emits one call_end', async () => {
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const ends = [];
        emitter.on(EVENTS.TOOL.CALL_END, (event) => ends.push(event));
        const journal = new ExecutionJournal();
        journal.begin({
            key: toolJournalKey({ runId: journal.runId, boundary: 'b1', name: 'count', args: { n: 1 } }),
            meta: { name: 'count' },
        });
        const [res] = /** @type {any[]} */ (await executeTools({
            toolCalls: [{ id: 'c1', name: 'count', arguments: '{"n":1}' }],
            toolLibrary: [{ name: 'count', parameters: { type: 'object', properties: { n: { type: 'number' } } }, execute: async () => 'ran' }],
            journal, boundary: 'b1', emitter, runContext: new RunContext({ runId: 'r2' }),
        }));
        assert.equal(res.success, false);
        assert.equal(ends.length, 1, 'the interrupted branch must not emit a second call_end');
        assert.equal(ends[0].interrupted, true);
    });

    it('an outputSchema failure emits one call_end', async () => {
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const ends = [];
        emitter.on(EVENTS.TOOL.CALL_END, (event) => ends.push(event));
        const [res] = /** @type {any[]} */ (await executeTools({
            toolCalls: [{ id: 'c1', name: 'shaped', arguments: '{}' }],
            toolLibrary: [{
                name: 'shaped',
                parameters: { type: 'object', properties: {} },
                outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
                execute: async () => ({ count: 'not a number' }),
            }],
            emitter, runContext: new RunContext({ runId: 'r3' }),
        }));
        assert.equal(res.success, false);
        assert.equal(ends.length, 1, 'the outputSchema branch must not emit a second call_end');
    });

    it('an aborted round ends only after every call end', async () => {
        const emitter = new EventEmitter();
        /** @type {any[]} */
        const events = [];
        for (const name of [EVENTS.TOOL.ROUND_START, EVENTS.TOOL.CALL_START, EVENTS.TOOL.CALL_END, EVENTS.TOOL.ROUND_END]) {
            emitter.on(name, (event) => events.push(event));
        }
        const hooks = createHooks();
        // `quick`'s effect is already done: this hook holds its call open past
        // the abort, so its call_end would land after the round end.
        hooks.add({ name: HOOKS.TOOL_AFTER, fn: async (/** @type {unknown} */ value, /** @type {{name?: string}|null|undefined} */ ctx) => {
            if (ctx?.name === 'quick') await new Promise((resolve) => setTimeout(resolve, 30));
            return value;
        } });
        const ac = new AbortController();
        const slow = {
            name: 'slow',
            parameters: { type: 'object', properties: {} },
            execute: async (/** @type {{signal: *}} */ { signal }) => new Promise((_, reject) => {
                const err = Object.assign(new Error('cancelled'), { name: 'AbortError' });
                if (signal?.aborted) return reject(err);
                signal?.addEventListener('abort', () => reject(err), { once: true });
            })
        };
        const quick = { name: 'quick', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' };
        const pending = executeTools({
            toolCalls: [{ id: 'a', name: 'quick', arguments: '{}' }, { id: 'b', name: 'slow', arguments: '{}' }],
            toolLibrary: [quick, slow],
            signal: ac.signal, emitter, runContext: new RunContext({ runId: 'r4' }), hooks,
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        ac.abort(new Error('cancelled'));
        await assert.rejects(pending, (e) => isAbortError({ err: e }));
        // Let the call that was still in flight finish, so a late call_end can
        // be seen after the round end.
        await new Promise((resolve) => setTimeout(resolve, 60));

        const roundEnd = events.at(-1);
        assert.equal(roundEnd?.event, EVENTS.TOOL.ROUND_END, 'the round end is the last event');
        assert.equal(roundEnd.count, 2);
        assert.equal(roundEnd.okCount + roundEnd.failCount, 2, 'the round counts add up');
        const ended = events.filter((e) => e.event === EVENTS.TOOL.CALL_END).map((e) => e.id).sort();
        assert.deepEqual(ended, ['a', 'b'], 'each call is paired before the round closes');
    });

    it('a tool with no execute implementation still starts before it ends', async () => {
        const emitter = new EventEmitter();
        /** @type {string[]} */
        const events = [];
        emitter.on(EVENTS.TOOL.CALL_START, () => events.push('start'));
        emitter.on(EVENTS.TOOL.CALL_END, () => events.push('end'));
        const [res] = /** @type {any[]} */ (await executeTools({
            toolCalls: [{ id: 'c1', name: 'noexec', arguments: '{}' }],
            toolLibrary: [{ name: 'noexec', parameters: { type: 'object', properties: {} } }],
            emitter, runContext: new RunContext({ runId: 'r5' }),
        }));
        assert.equal(res.success, false);
        assert.deepEqual(events, ['start', 'end'], 'a call end must not precede its start');
    });
});

describe('runCommand hardening (M8)', () => {
    it('a pre-aborted signal aborts synchronously', async () => {
        const ac = new AbortController();
        ac.abort(new Error('gone'));
        await assert.rejects(
            runCommand({ command: 'sleep', args: ['5'], signal: ac.signal }),
            (e) => isAbortError({ err: e })
        );
    });

    it('runaway output is capped, not accumulated unboundedly', async () => {
        const { code, stdout, truncated } = await runCommand({ command: 'node', args: ['-e', 'process.stdout.write("x".repeat(5_000_000))'], maxBuffer: 1024 });
        assert.ok(truncated, 'cap must be flagged');
        assert.ok(stdout.length <= 1024);
        // F2-9: the cap bounds the buffer, not the child, so the exit code is
        // the command's real one instead of the null a self-inflicted SIGTERM
        // used to produce. The child printed 5 MB and still exited 0.
        assert.equal(code, 0);
    });

    it('a truncated command killed by a signal is a failure, not a capped success', async () => {
        // The old escape hatch ("a single command is killed by its own cap")
        // reported this as success: a null exit code plus a truncated buffer.
        // The cap no longer kills, so a null code can only be a signal death.
        const tool =  (createShellTool({ options: {
            maxOutputLength: 512,
            approvalCallback: async () => true
        } }));
        /** @type {{success: boolean, exitCode?: number|null, truncated?: boolean, error?: string}} */
        const res = await tool.execute({
            args: {
                command: 'node',
                args: ['-e', "process.stdout.write('x'.repeat(8000)); process.kill(process.pid, 'SIGKILL');"]
            }
        });
        assert.equal(res.success, false, 'a signal death is a tool failure');
        assert.equal(res.exitCode, null);
        assert.equal(res.truncated, true, 'the cap is still reported');
        assert.match(String(res.error), /exited with code null/);
    });

    it('an INTERNAL timeout is a tool failure, not a loop cancellation', async () => {
        const ac = new AbortController();
        const tool =  (createShellTool({ options: { approvalCallback: async () => true, timeoutMs: 100 } }));
        const res = await tool.execute({ args: { command: 'node', args: ['-e', 'setTimeout(()=>{}, 5000)'] }, signal: ac.signal });
        assert.equal(res.success, false, 'a timeout must surface as a failed tool result');
        assert.ok(res.error.includes('timed out'), 'the tool failure names the timeout');
        assert.equal(ac.signal.aborted, false, 'the caller signal must be untouched');
    });
});
