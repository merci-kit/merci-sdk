// @ts-check
/**
 * G2-1: the safe tier must not read a directory's contents without approval.
 * `diff -N dir` printed every file in the folder, including `secret.env`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createShellTool } from '../lib/tools/shell-tools.mjs';

/** @returns {{ws: string, asked: string[]}} */
function workspace() {
    const ws = mkdtempSync(join(tmpdir(), 'merci-g21-'));
    writeFileSync(join(ws, 'secret.env'), 'OPENAI_API_KEY=sk-FAKE-PROBE-SECRET\n');
    mkdirSync(join(ws, 'sub'));
    writeFileSync(join(ws, 'sub', 'note.txt'), 'inside\n');
    return { ws, asked: [] };
}

/** @param {{ws: string, asked: string[]}} arg0 */
function toolFor({ ws, asked }) {
    return createShellTool({ options: {
        roots: [ws],
        cwd: ws,
        approvalCallback: async (/** @type {any} */ req) => { asked.push(String(req?.command ?? req?.name ?? 'approval')); return false; },
    } });
}

for (const [label, args] of /** @type {Array<[string, string[]]>} */ ([
    ['dot-and-empty', ['-N', '.', 'empty']],
    ['two-directories', ['.', 'sub']],
])) {
    test(`diff ${label} on a directory operand asks for approval and prints nothing`, async () => {
        const ctx = workspace();
        const res = await toolFor(ctx).execute({ args: { command: 'diff', args } });
        assert.equal(ctx.asked.length, 1, 'a directory operand must escalate to HITL');
        assert.equal(res.success, false);
        assert.doesNotMatch(String(res.result ?? ''), /FAKE-PROBE-SECRET/);
    });
}

test('cat on a directory operand asks; ls/du/stat on one does not', async () => {
    const ctx = workspace();
    const tool = toolFor(ctx);
    await tool.execute({ args: { command: 'cat', args: ['.'] } });
    assert.equal(ctx.asked.length, 1, 'cat . must escalate');
    for (const command of ['ls', 'du', 'stat', 'file', 'df']) {
        const res = await tool.execute({ args: { command, args: ['.'] } });
        assert.equal(ctx.asked.length, 1, `${command} . describes the directory and must stay safe`);
        assert.notEqual(res.error, 'Tool requires approval but no approval handler is configured.');
    }
});

for (const args of [['--from-file=sub', 'note.txt'], ['--to-file=sub'], ['--from-file', 'sub', 'note.txt']]) {
    test(`diff ${args.join(' ')} cannot read a directory through a file option`, async () => {
        const ctx = workspace();
        const res = await toolFor(ctx).execute({ args: { command: 'diff', args } });
        assert.equal(ctx.asked.length, 1, 'a directory read through a fileFlags operand must escalate');
        assert.equal(res.success, false);
    });
}
