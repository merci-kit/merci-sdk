// @ts-check


/**
 * @file F2-9: a command over the buffer cap is truncated, not killed.
 * @version 0.12.0
 *
 * @description
 * `runPipeline` stops buffering at `maxBuffer` and reports `truncated: true`,
 * while `runCommand` aborted its own child on overflow, so a chatty hook failed
 * with `code: null` and a message that hid the cause. The buffer cap now only
 * stops buffering: the child runs to its own exit code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LIMITS } from '../lib/core/limit-config.mjs';
import { WorkspaceError } from '../lib/core/errors.mjs';
import { runCommand, RUN_COMMAND_TIMEOUT_CODE } from '../lib/support/run-command.mjs';
import { runWorkspaceHook } from '../lib/agentic/workspace/hooks.mjs';

test('F2-9 a noisy command truncates instead of dying', async () => {
    const result = await runCommand({
        command: process.execPath,
        args: ['-e', "process.stdout.write('x'.repeat(200000))"],
        maxBuffer: 1024,
        timeoutMs: 20_000
    });
    assert.equal(result.code, 0, 'the child finished on its own; the cap is not a kill');
    assert.equal(result.truncated, true);
    assert.equal(result.stdout.length, 1024, 'the buffer stopped at the cap');
});

test('F2-9 a noisy command that also misses its deadline still rejects', async () => {
    // The cap no longer aborts, so a timeout must reject even after the buffer
    // filled: the truncation must not swallow the deadline into `code: null`.
    const result = runCommand({
        command: process.execPath,
        args: ['-e', "setInterval(() => process.stdout.write('x'.repeat(65536)), 5)"],
        maxBuffer: 1024,
        timeoutMs: 300
    });
    await assert.rejects(result, (error) => {
        assert.equal(/** @type {{code?: string}} */ (error).code, RUN_COMMAND_TIMEOUT_CODE);
        return true;
    });
});

test('F2-9 a truncated command that also errors still rejects', async () => {
    // A child `error` is a spawn (or kill) failure, never a result: the old
    // branch resolved `{ code: null, truncated: true }`, which the shell tool
    // must now read as a signal death — a false success for a command that
    // never ran. Inject a child that overflows and then errors.
    const { EventEmitter } = await import('node:events');
    const child = new EventEmitter();
    const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    /** @type {Function} */
    const spawn = () => {
        process.nextTick(() => {
            stdout.emit('data', 'x'.repeat(4096));
            child.emit('error', new Error('spawn EACCES'));
        });
        return { pid: 4_242, stdout, stderr, kill: () => true, on: child.on.bind(child) };
    };
    await assert.rejects(
        () => runCommand({ command: 'never-runs', spawn, maxBuffer: 1024 }),
        /spawn EACCES/
    );
});

test('F2-9 a hook that exceeds the buffer reports hook_output_limit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'merci-hook-output-'));
    const bytes = LIMITS.run_command_max_buffer_bytes + 1_048_576;
    try {
        await assert.rejects(
            () => runWorkspaceHook({
                hook: 'afterRun',
                script: `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(${bytes}));process.exitCode=3"`,
                workspace: { workItemId: 'MER-NOISY-1', identifier: 'MER-NOISY-1', key: 'k', path: cwd },
                timeoutMs: 30_000
            }),
            (error) => {
                assert.ok(error instanceof WorkspaceError, `expected WorkspaceError, got ${String(error)}`);
                assert.equal(error.reason, 'hook_output_limit');
                assert.match(error.message, /exited with code 3/, 'the real exit code is reported');
                return true;
            }
        );
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});
