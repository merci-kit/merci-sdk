// @ts-check
/**
 * A model-authored condition could reach Promise through a computed global
 * name (`globalThis['Pro'+'mise']`) — no `async`, `await` or `Promise` literal
 * for the word check to catch — and the microtask chain it starts kept running
 * AFTER `runInContext` returned, outside the 500 ms timeout, hanging the
 * process. `microtaskMode: 'afterEvaluate'` drains the queue inside the
 * evaluation, so the timeout applies.
 *
 * The loop runs in a child process: an infinite microtask drain inside the
 * test runner's async-hook scope corrupts its context stack, and a regression
 * must fail this test, not the whole suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compileCondition } from '../lib/agentic/state-machine/machine.mjs';
import { runCommand } from '../lib/support/run-command.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const machineUrl = pathToFileURL(path.resolve(here, '../lib/agentic/state-machine/machine.mjs')).href;

test('a microtask loop in a model-authored condition times out instead of hanging', async () => {
    const source = "(()=>{const P=globalThis['Pro'+'mise'];const loop=()=>{P.resolve().then(loop)};loop();return true;})()";
    const script = `
        import { compileCondition } from ${JSON.stringify(machineUrl)};
        const fn = compileCondition({ src: ${JSON.stringify(source)} });
        try {
            fn({});
            console.log('NO-THROW');
            process.exit(2);
        } catch (err) {
            console.log('THREW:' + String(err?.code ?? err?.name ?? err?.message) + ':' + String(err?.message ?? ''));
        }
    `;
    const out = await runCommand({
        command: process.execPath,
        args: ['--input-type=module', '-e', script],
        timeoutMs: 8000,
    });
    // D-8: the evaluator now runs in its own process and reports its timeout as
    // a typed ConfigurationError; the old vm code is accepted if the in-process
    // fallback ran instead.
    assert.match(String(out.stdout), /THREW:(MERCI-CONFIG-ERR:.*(time budget|timed out)|ERR_SCRIPT_EXECUTION_TIMEOUT)/i, `child said: ${out.stdout}`);
});

test('a normal condition still evaluates', () => {
    const fn = compileCondition({ src: "ctx.get('score') >= 8" });
    assert.equal(fn({ score: 9 }), true);
    assert.equal(fn({ score: 2 }), false);
});
