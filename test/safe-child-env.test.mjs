// @ts-check
/**
 * The MCP SDK's child-environment allowlist has no extension hook, so a child
 * process lost `LANG`/`LC_ALL`/`LC_CTYPE`/`TZ`/`TMPDIR`: date formatting and
 * the locale fell back to C. `safeChildEnv()` merges them on top.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { safeChildEnv } from '../lib/support/child-env.mjs';
import { runCommand } from '../lib/support/run-command.mjs';
import { McpClient } from '../lib/tools/mcp-client.mjs';

const KEYS = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR'];

test('safeChildEnv carries the locale and timezone variables that are set', () => {
    /** @type {Record<string, string|undefined>} */
    const saved = {};
    for (const key of KEYS) saved[key] = process.env[key];
    try {
        process.env.LANG = 'en_US.UTF-8';
        process.env.TZ = 'Europe/Paris';
        delete process.env.LC_ALL;
        const env = safeChildEnv();
        assert.equal(env.LANG, 'en_US.UTF-8');
        assert.equal(env.TZ, 'Europe/Paris');
        assert.equal(env.LC_ALL, undefined, 'an unset variable is not invented');
        assert.equal(typeof env.PATH, 'string', 'the SDK allowlist is the base');
    } finally {
        for (const key of KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
});

test('runCommand passes the merged environment to the child', async () => {
    const previous = process.env.TZ;
    process.env.TZ = 'Pacific/Auckland';
    try {
        const out = await runCommand({ command: process.execPath, args: ['-e', 'process.stdout.write(String(process.env.TZ))'] });
        assert.equal(String(out.stdout).trim(), 'Pacific/Auckland');
    } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
    }
});

test('the MCP stdio transport gets the same merged environment', () => {
    const previous = process.env.LANG;
    process.env.LANG = 'fr_FR.UTF-8';
    try {
        const client = new McpClient({ command: 'unused-binary', args: [] });
        const transport = /** @type {any} */ (client)._createTransport();
        const env = transport._serverParams?.env ?? transport.serverParams?.env;
        assert.ok(env, 'the transport carries an env bag');
        assert.equal(env.LANG, 'fr_FR.UTF-8');
    } finally {
        if (previous === undefined) delete process.env.LANG;
        else process.env.LANG = previous;
    }
});
