// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runCommand } from '../lib/support/run-command.mjs';
import { createShellTool } from '../lib/tools/shell-tools.mjs';

// 0.8.0 item F: a child process never inherits the parent's secrets by default.

const PRINT = ['-e', 'process.stdout.write(JSON.stringify({ secret: process.env.FAKE_SECRET ?? null, path: Boolean(process.env.PATH), extra: process.env.MERCI_EXTRA ?? null }))'];

/** @param {() => Promise<void>} fn */
async function withSecret(fn) {
    process.env.FAKE_SECRET = 'sk-test-not-a-real-key';
    try { await fn(); } finally { delete process.env.FAKE_SECRET; }
}

test('F: a child does not see a parent secret; PATH and an explicit env still arrive', () => withSecret(async () => {
    const { stdout } = await runCommand({ command: process.execPath, args: PRINT, env: { MERCI_EXTRA: 'x' } });
    assert.deepEqual(JSON.parse(stdout), { secret: null, path: true, extra: 'x' });
}));

test('F: inheritEnv: true restores the whole parent environment', () => withSecret(async () => {
    const { stdout } = await runCommand({ command: process.execPath, args: PRINT, inheritEnv: true });
    assert.equal(JSON.parse(stdout).secret, 'sk-test-not-a-real-key');
}));

test('F: the shell tool keeps the secret out unless inheritEnv is set', () => withSecret(async () => {
    /** @param {{inheritEnv?: boolean}} arg0 */
    const run = async ({ inheritEnv }) => {
        const tool = /** @type {any} */ (createShellTool({ options: { approvalCallback: async () => true, ...(inheritEnv ? { inheritEnv } : {}) } }));
        const res = await tool.execute({ args: { command: 'node', args: PRINT } });
        assert.equal(res.success, true, JSON.stringify(res));
        return JSON.parse(res.stdout);
    };
    assert.equal((await run({})).secret, null);
    assert.equal((await run({ inheritEnv: true })).secret, 'sk-test-not-a-real-key');
}));

test('F: the browser engine binary runs through runCommand — no secret, ENOENT and exit codes still mapped', () => withSecret(async () => {
    const { ObscuraEngine } = await import('../lib/agentic/browser/engines.mjs');
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'merci-child-env-'));
    try {
        const ok = join(dir, 'fake-obscura');
        writeFileSync(ok, `#!${process.execPath}\nprocess.stdout.write('secret=' + (process.env.FAKE_SECRET ?? 'none'));\n`);
        chmodSync(ok, 0o755);
        const failing = join(dir, 'failing-obscura');
        writeFileSync(failing, `#!${process.execPath}\nprocess.exit(3);\n`);
        chmodSync(failing, 0o755);
        const url = 'https://example.com/';
        const [seen] = await ObscuraEngine.fetch({ input: url, opts: { binaryPath: ok } });
        assert.equal(seen.content, 'secret=none');
        const [exited] = await ObscuraEngine.fetch({ input: url, opts: { binaryPath: failing } });
        assert.match(String(exited.error), /exited with code 3/);
        const [missing] = await ObscuraEngine.fetch({ input: url, opts: { binaryPath: join(dir, 'nope') } });
        assert.match(String(missing.error), /Obscura binary not found/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}));

test('F review: output larger than a pipe chunk keeps multibyte characters whole', async () => {
    const { stdout } = await runCommand({ command: process.execPath, args: ['-e', "process.stdout.write('x' + '日本語'.repeat(60000))"] });
    assert.equal(stdout.length, 180001);
    assert.equal(stdout.includes('�'), false, 'no replacement characters at chunk boundaries');
});

test('F review: the obscura binary takes an explicit env or inheritEnv, like the other children', () => withSecret(async () => {
    const { ObscuraEngine } = await import('../lib/agentic/browser/engines.mjs');
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'merci-child-env-'));
    try {
        const bin = join(dir, 'fake-obscura');
        writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write([process.env.HTTPS_PROXY ?? '-', process.env.FAKE_SECRET ?? '-'].join(' '));\n`);
        chmodSync(bin, 0o755);
        /** @param {Record<string, unknown>} extra */
        const read = async (extra) => (await ObscuraEngine.fetch({ input: 'https://example.com/', opts: { binaryPath: bin, ...extra } }))[0].content;
        assert.equal(await read({}), '- -');
        assert.equal(await read({ env: { HTTPS_PROXY: 'http://proxy:3128' } }), 'http://proxy:3128 -');
        assert.equal(await read({ inheritEnv: true }), `- sk-test-not-a-real-key`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}));
