// @ts-check
/**
 * @file Script-tool machinery: interpreter selection, contained resolution, and
 * the plain tool object that runs a fixture script.
 * @version 0.12.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigurationError } from '../lib/core/errors.mjs';
import { LIMITS } from '../lib/core/limit-config.mjs';
import { createScriptTool, resolveScript, resolveScriptInterpreter } from '../lib/tools/script-tools.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/agents/scripts/', import.meta.url));


/**
 * Runs `fn` and returns the `ConfigurationError` it rejects with.
 * @param {{fn: () => Promise<unknown>}} arg0 -
 * @returns {Promise<{option?: string, reason?: string}>}
 */
async function rejection({ fn }) {
    try {
        await fn();
    } catch (error) {
        assert.ok(error instanceof ConfigurationError, 'rejection must be a ConfigurationError');
        return /** @type {{option?: string, reason?: string}} */ (error);
    }
    assert.fail('expected the call to reject');
}


test('script interpreters come from the extension and never guess sh', () => {
    assert.equal(resolveScriptInterpreter({ path: 'run.mjs' }), 'node');
    assert.equal(resolveScriptInterpreter({ path: 'run.js' }), 'node');
    assert.equal(resolveScriptInterpreter({ path: 'run.cjs' }), 'node');
    assert.equal(resolveScriptInterpreter({ path: 'run.sh' }), 'bash');
    assert.equal(resolveScriptInterpreter({ path: 'run.bash' }), 'bash');
    assert.equal(resolveScriptInterpreter({ path: 'run.zsh' }), 'zsh');
    assert.equal(resolveScriptInterpreter({ path: 'run.PY' }), 'python3');
    assert.equal(resolveScriptInterpreter({ path: 'run.rb' }), 'ruby');
    assert.equal(resolveScriptInterpreter({ path: 'run.pl' }), 'perl');
    assert.equal(resolveScriptInterpreter({ path: 'run.txt' }), null);
    assert.equal(resolveScriptInterpreter({ path: 'run' }), null);
    assert.equal(resolveScriptInterpreter({}), null);
});

test('resolveScript returns the real path, interpreter, size and hash', async () => {
    const resolved = await resolveScript({ script: 'echo-args.mjs', baseDir: FIXTURES, root: FIXTURES });
    assert.equal(resolved.path, await realpath(join(FIXTURES, 'echo-args.mjs')));
    assert.equal(resolved.interpreter, 'node');
    assert.ok(resolved.size > 0);
    assert.match(resolved.hash, /^[0-9a-f]{64}$/);
});

test('resolveScript rejects a script outside the root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-script-outside-'));
    try {
        await writeFile(join(dir, 'outside.mjs'), 'process.stdout.write("x");\n');
        const error = await rejection({ fn: () => resolveScript({ script: 'outside.mjs', baseDir: dir, root: FIXTURES }) });
        assert.equal(error.option, 'script');
        assert.equal(error.reason, 'script_outside_root');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('resolveScript rejects a symlink even when it points inside the root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merci-script-link-'));
    try {
        await symlink(join(FIXTURES, 'echo-args.mjs'), join(dir, 'link.mjs'));
        const error = await rejection({ fn: () => resolveScript({ script: 'link.mjs', baseDir: dir, root: dir }) });
        assert.equal(error.reason, 'script_symlink');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('resolveScript rejects missing, non-file, unsupported and oversize scripts', async () => {
    assert.equal((await rejection({ fn: () => resolveScript({ script: 'nope.mjs', baseDir: FIXTURES, root: FIXTURES }) })).reason, 'script_missing');
    assert.equal((await rejection({ fn: () => resolveScript({ script: '.', baseDir: FIXTURES, root: FIXTURES }) })).reason, 'script_not_file');
    assert.equal((await rejection({ fn: () => resolveScript({ script: 'notes.txt', baseDir: FIXTURES, root: FIXTURES }) })).reason, 'script_unsupported');
    assert.equal((await rejection({ fn: () => resolveScript({ script: 'echo-args.mjs', baseDir: FIXTURES, root: FIXTURES, maxBytes: 10 }) })).reason, 'script_too_large');
});

test('createScriptTool advertises code and approval, and passes args as one JSON argv', async () => {
    const resolved = await resolveScript({ script: 'echo-args.mjs', baseDir: FIXTURES, root: FIXTURES });
    const tool = createScriptTool({
        definition: { name: 'echo', description: 'Echo.', scriptPath: resolved.path, interpreter: resolved.interpreter, baseDir: FIXTURES }
    });
    assert.equal(tool.runsCode, true);
    assert.equal(tool.idempotent, false);
    assert.equal(tool.requiresApproval, true);
    const open = createScriptTool({ definition: { name: 'open', scriptPath: resolved.path, interpreter: 'node', requiresApproval: false } });
    assert.equal(open.requiresApproval, false);

    const args = { hello: 'world', list: [1, 2] };
    assert.deepEqual(JSON.parse(await tool.execute({ args, signal: null })), args);
});

test('a non-zero exit becomes a thrown error carrying stderr', async () => {
    const resolved = await resolveScript({ script: 'fail.mjs', baseDir: FIXTURES, root: FIXTURES });
    const tool = createScriptTool({ definition: { name: 'fail', scriptPath: resolved.path, interpreter: resolved.interpreter, baseDir: FIXTURES } });
    await assert.rejects(() => tool.execute({ args: {} }), /fixture boom/);
});

test('script output is capped', async () => {
    const resolved = await resolveScript({ script: 'echo-args.mjs', baseDir: FIXTURES, root: FIXTURES });
    const tool = createScriptTool({ definition: { name: 'noisy', scriptPath: resolved.path, interpreter: resolved.interpreter, baseDir: FIXTURES } });
    const text = await tool.execute({ args: { text: 'x'.repeat(LIMITS.agent_script_output_chars + 10_000) } });
    assert.equal(text.length, LIMITS.agent_script_output_chars);
});

test('only allowlisted parent env keys reach the script', async () => {
    process.env.MERCI_TEST_ALLOWED = 'visible';
    process.env.MERCI_TEST_SECRET = 'hidden';
    try {
        const resolved = await resolveScript({ script: 'env-report.mjs', baseDir: FIXTURES, root: FIXTURES });
        const tool = createScriptTool({
            definition: { name: 'env', scriptPath: resolved.path, interpreter: resolved.interpreter, baseDir: FIXTURES, envKeys: ['MERCI_TEST_ALLOWED'] }
        });
        assert.deepEqual(JSON.parse(await tool.execute({ args: {} })), { allowed: 'visible', secret: null });
    } finally {
        delete process.env.MERCI_TEST_ALLOWED;
        delete process.env.MERCI_TEST_SECRET;
    }
});

test('arguments are validated before the script is spawned', async () => {
    const { executeTools } = await import('../lib/tools/tool-execution.mjs');
    const resolved = await resolveScript({ script: 'echo-args.mjs', baseDir: FIXTURES, root: FIXTURES });
    const tool = createScriptTool({
        definition: {
            name: 'needs_path',
            description: 'needs a path',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            scriptPath: resolved.path,
            interpreter: resolved.interpreter,
            baseDir: FIXTURES
        }
    });
    const [outcome] = await executeTools({
        toolCalls: [{ id: 'call-1', name: 'needs_path', args: {} }],
        toolLibrary: [tool],
        signal: null
    });
    const failed = /** @type {any} */ (outcome);
    assert.equal(failed.success, false);
    assert.match(String(failed.error), /Invalid tool arguments/);
});
