// @ts-check

/**
 * Structured pipelines for `execute_shell_command`.
 *
 * The tool has no shell: `|`, `>`, `$()` and globs never reach a process.
 * A pipeline restores the one shell feature an agent actually needs — chaining
 * stages through stdout — while keeping every stage on the same blocklist,
 * safe-option policy and root confinement as a single command.
 *
 * Approval contract: a pipeline asks ONCE, and the prompt names the whole
 * chain, so a human is never shown stage 1 while stage 2 does something else.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createShellTool } from '../lib/tools/shell-tools.mjs';
import { runPipeline } from '../lib/support/run-command.mjs';

/**
 * @param {{approve?: boolean}} [arg0]
 * @returns {{tool: any, asked: Array<{command: string, args: string[], meta: any}>}}
 */
function makeTool({ approve = false } = {}) {
    /** @type {Array<{command: string, args: string[], meta: any}>} */
    const asked = [];
    const tool = createShellTool({ options: {
        approvalCallback: async (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ meta) => {
            asked.push({ command, args, meta });
            return approve;
        },
    } });
    return { tool, asked };
}

describe('shell pipeline — execution', () => {
    it('runs two safe stages and returns the last stage output', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({
            args: { pipeline: [
                { command: 'echo', args: ['hello'] },
                { command: 'wc', args: ['-l'] }
            ] }
        });
        assert.equal(res.success, true, JSON.stringify(res));
        assert.match(String(res.stdout).trim(), /^1$/);
        assert.equal(asked.length, 0, 'both stages are read-only: no prompt');
    });

    it('a safe three-stage chain asks nothing', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({
            args: { pipeline: [
                { command: 'rg', args: ['--files', '-g', '*.mjs'] },
                { command: 'sort', args: [] },
                { command: 'head', args: ['-n', '3'] }
            ] }
        });
        assert.equal(res.success, true, JSON.stringify(res));
        assert.ok(String(res.stdout).trim().split('\n').length <= 3);
        assert.equal(asked.length, 0);
    });

    it('the exit code is the last stage, so an empty search is not a failure', async () => {
        const { tool } = makeTool();
        const res = await tool.execute({
            args: { pipeline: [
                { command: 'rg', args: ['--files', '-g', '*.no-such-extension'] },
                { command: 'wc', args: ['-l'] }
            ] }
        });
        assert.equal(res.success, true, JSON.stringify(res));
        assert.match(String(res.stdout).trim(), /^0$/);
    });

    it('a closed downstream pipe does not crash the upstream stage', async () => {
        const { tool } = makeTool();
        const res = await tool.execute({
            args: { pipeline: [
                { command: 'rg', args: ['--files', '-g', '*.mjs'] },
                { command: 'head', args: ['-n', '1'] }
            ] }
        });
        assert.equal(res.success, true, JSON.stringify(res));
        assert.equal(String(res.stdout).trim().split('\n').length, 1);
    });

    it('waits for every stage, not only the last one', async () => {
        const { tool } = makeTool({ approve: true });
        const started = Date.now();
        const res = await tool.execute({
            args: { pipeline: [
                { command: 'node', args: ['-e', 'setTimeout(() => {}, 80)'] },
                { command: 'echo', args: ['done'] }
            ] }
        });
        const elapsed = Date.now() - started;
        assert.equal(res.success, true, JSON.stringify(res));
        assert.ok(elapsed >= 70, `the pipeline must not resolve before its first stage exits (${elapsed}ms)`);
    });

    it('an external abort still cancels a pipeline after a stderr flood', async () => {
        const { tool } = makeTool({ approve: true });
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 150);
        await assert.rejects(
            () => tool.execute({
                args: { pipeline: [
                    { command: 'node', args: ['-e', 'process.stderr.write("E".repeat(20000)); setTimeout(() => {}, 4000)'] },
                    { command: 'cat', args: [] }
                ] },
                signal: ac.signal
            }),
            (/** @type {any} */ err) => {
                assert.equal(err.name, 'AbortError', 'a cancelled call is a cancellation, not a success');
                return true;
            }
        );
    });

    it('a noisy stage does not destroy the last stage output', async () => {
        const { tool } = makeTool({ approve: true });
        const res = await tool.execute({
            args: { pipeline: [
                { command: 'node', args: ['-e', 'process.stderr.write("E".repeat(20000)); process.stdout.write("REAL ANSWER\\n")'] },
                { command: 'cat', args: [] }
            ] }
        });
        assert.equal(res.success, true, 'a diagnostic stream must not fail the pipeline');
        assert.match(String(res.stdout), /REAL ANSWER/, 'the answer survives the stderr cap');
        assert.equal(res.truncated, true);
    });

    it('a large producer does not deadlock when the reader stops early', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-pipeline-big-'));
        const file = join(dir, 'big.txt');
        writeFileSync(file, `${'x'.repeat(1023)}\n`.repeat(1024));
        const tool = createShellTool({ options: {
            approvalCallback: async () => true,
            timeoutMs: 2_000,
            roots: [process.cwd()]
        } });
        try {
            const started = Date.now();
            const res = await tool.execute({ args: { pipeline: [
                { command: 'cat', args: [file] },
                { command: 'head', args: ['-n', '1'] }
            ] } });
            const elapsed = Date.now() - started;
            assert.equal(res.success, true, JSON.stringify(res));
            assert.equal(String(res.stdout).trim().split('\n').length, 1);
            assert.ok(elapsed < 1_500, `the closed pipe must not hold the producer (${elapsed}ms)`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('runPipeline rejects a pre-aborted signal without spawning', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-pipeline-abort-'));
        const marker = join(dir, 'spawned.txt');
        const controller = new AbortController();
        controller.abort();
        try {
            await assert.rejects(
                () => runPipeline({ signal: controller.signal, stages: [
                    { command: 'node', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] }
                ] }),
                (/** @type {any} */ err) => {
                    assert.equal(err.name, 'AbortError');
                    return true;
                }
            );
            assert.equal(existsSync(marker), false, 'an aborted call must not run a stage');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a last stage killed by a signal fails even when stderr was capped', async () => {
        const tool = createShellTool({ options: {
            approvalCallback: async () => true,
            maxOutputLength: 100,
            roots: [process.cwd()]
        } });
        const res = await tool.execute({ args: { pipeline: [
            { command: 'node', args: ['-e', 'process.stderr.write("E".repeat(9000))'] },
            { command: 'node', args: ['-e', 'process.kill(process.pid, "SIGKILL")'] }
        ] } });
        assert.equal(res.success, false, 'a signalled last stage is a failure, not a truncated success');
        assert.equal(res.exitCode, null);
        assert.equal(res.truncated, true);
    });

    it('the pipeline stdout cap is a byte ceiling and is flagged', async () => {
        const res = await runPipeline({
            stages: [{ command: 'printf', args: ['abc'] }],
            maxBuffer: 2
        });
        assert.equal(res.code, 0);
        assert.equal(res.stdout.length, 2);
        assert.equal(res.truncated, true);
    });
});

describe('shell pipeline — the gate', () => {
    it('a gated stage prompts once and the prompt names the whole chain', async () => {
        const { tool, asked } = makeTool({ approve: true });
        const res = await tool.execute({
            args: { pipeline: [
                { command: 'rg', args: ['-n', 'MerciError', 'lib'] },
                { command: 'head', args: ['-n', '2'] }
            ] }
        });
        assert.equal(asked.length, 1, 'one prompt for the chain, not one per stage');
        assert.match(asked[0].command, /rg/);
        assert.match(asked[0].command, /\|/, 'the prompt shows the pipe');
        assert.match(asked[0].command, /head/);
        assert.equal(res.success, true, JSON.stringify(res));
        assert.ok(String(res.stdout).trim().split('\n').length <= 2);
    });

    it('a denied pipeline runs nothing', async () => {
        const { tool, asked } = makeTool({ approve: false });
        const res = await tool.execute({
            args: { pipeline: [
                { command: 'rg', args: ['-n', 'MerciError', 'lib'] },
                { command: 'head', args: ['-n', '2'] }
            ] }
        });
        assert.equal(asked.length, 1);
        assert.equal(res.success, false);
        assert.match(String(res.error), /denied/i);
    });

    it('a blocklisted stage rejects the pipeline before anything runs', async () => {
        const { tool, asked } = makeTool({ approve: true });
        const res = await tool.execute({
            args: { pipeline: [
                { command: 'echo', args: ['x'] },
                { command: 'rm', args: ['-rf', 'x'] }
            ] }
        });
        assert.equal(res.success, false);
        assert.match(String(res.error), /blocklist/i);
        assert.equal(asked.length, 0, 'the blocklist needs no human');
    });

    it('an unknown option in a later stage still escalates', async () => {
        const { tool, asked } = makeTool({ approve: false });
        const res = await tool.execute({
            args: { pipeline: [
                { command: 'echo', args: ['x'] },
                { command: 'sort', args: ['--totally-unknown'] }
            ] }
        });
        assert.equal(asked.length, 1);
        assert.equal(res.success, false);
    });

    it('a path outside the roots in a later stage escalates', async () => {
        const outside = mkdtempSync(join(tmpdir(), 'merci-pipeline-outside-'));
        writeFileSync(join(outside, 'data.txt'), 'outside\n');
        const { tool, asked } = makeTool({ approve: false });
        const res = await tool.execute({
            args: { pipeline: [
                { command: 'echo', args: ['x'] },
                { command: 'cat', args: [join(outside, 'data.txt')] }
            ] }
        });
        assert.equal(asked.length, 1);
        assert.equal(res.success, false);
    });

    it('the approval prompt escapes newlines and pipes inside an argument', async () => {
        const { tool, asked } = makeTool({ approve: true });
        const res = await tool.execute({
            args: { pipeline: [
                { command: 'node', args: ['-e', 'console.log(1)\n| cat /etc/passwd'] },
                { command: 'cat', args: [] }
            ] }
        });
        assert.equal(res.success, true, JSON.stringify(res));
        assert.equal(asked.length, 1);
        assert.doesNotMatch(asked[0].command, /\n/, 'a newline must not fake a stage break');
        assert.match(asked[0].command, /\\\|/, 'the pipe inside an argument is escaped');
        assert.equal(asked[0].command.split(' | ').length, 2, 'the chain separator is the only pipe');
    });
});

describe('shell pipeline — validation', () => {
    it('rejects a call that is both a command and a pipeline', async () => {
        const { tool } = makeTool();
        const res = await tool.execute({
            args: { command: 'ls', args: [], pipeline: [{ command: 'ls', args: [] }] }
        });
        assert.equal(res.success, false);
        assert.match(String(res.error), /either|both/i);
    });

    it('rejects an empty pipeline', async () => {
        const { tool } = makeTool();
        const res = await tool.execute({ args: { pipeline: [] } });
        assert.equal(res.success, false);
        assert.match(String(res.error), /pipeline/i);
    });

    it('rejects a malformed stage', async () => {
        const { tool } = makeTool();
        const res = await tool.execute({ args: { pipeline: [{ command: 'ls', args: 'not-an-array' }] } });
        assert.equal(res.success, false);
        assert.match(String(res.error), /args/i);
    });

    it('rejects more than five stages', async () => {
        const { tool } = makeTool();
        const stage = { command: 'echo', args: ['x'] };
        const res = await tool.execute({ args: { pipeline: [stage, stage, stage, stage, stage, stage] } });
        assert.equal(res.success, false);
        assert.match(String(res.error), /at most 5/i);
    });

    it('a path-qualified blocked command is rejected in a later stage', async () => {
        const { tool, asked } = makeTool({ approve: true });
        const res = await tool.execute({
            args: { pipeline: [
                { command: 'echo', args: ['x'] },
                { command: './rm', args: ['-rf', 'x'] }
            ] }
        });
        assert.equal(res.success, false);
        assert.match(String(res.error), /blocklist/i);
        assert.equal(asked.length, 0);
    });

    it('rejects a top-level args array beside a pipeline', async () => {
        const { tool } = makeTool();
        const res = await tool.execute({
            args: { args: ['rm', '-rf', '/'], pipeline: [{ command: 'echo', args: ['x'] }] }
        });
        assert.equal(res.success, false);
        assert.match(String(res.error), /stage args/i);
    });

    it('keeps the single-command form working', async () => {
        const { tool, asked } = makeTool();
        const res = await tool.execute({ args: { command: 'echo', args: ['plain'] } });
        assert.equal(res.success, true);
        assert.match(String(res.stdout), /plain/);
        assert.equal(asked.length, 0);
    });
});
