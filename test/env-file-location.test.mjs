// @ts-check
/**
 * @file `secret.env` is the consumer's file, not the package's.
 * @version 0.22.0
 *
 * @description
 * A published package has no `secret.env` next to it; the file lives in the
 * project that installed the SDK. Reading order: `MERCI_ENV_FILE`, then
 * `$CWD/secret.env`, then the package-relative file (the repo's own dev run).
 * Writing is narrower: a refreshed JAI bearer token is persisted only to
 * `MERCI_ENV_FILE` or the package-relative file, never to a project file the
 * SDK merely discovered. The checks run in child processes whose cwd is a
 * throwaway project, so the repo's own `secret.env` is never the answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const UTILS_URL = new URL('../lib/support/utils.mjs', import.meta.url).href;
const HTTP_CLIENT_URL = new URL('../lib/backends/jai-vendor/http-client.mjs', import.meta.url).href;

/**
 * Runs an ESM script in a child process and returns its stdout.
 * @param {{cwd: string, script: string, env?: Record<string, string|undefined>}} arg0
 * @returns {Promise<string>}
 */
async function runChild({ cwd, script, env = {} }) {
    /** @type {Record<string, string|undefined>} */
    const childEnv = { ...process.env };
    delete childEnv.MERCI_ENV_FILE_LOCATION_TEST;
    delete childEnv.MERCI_ENV_FILE;
    delete childEnv.VERTEX_CREDENTIALS;
    Object.assign(childEnv, env);
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd, env: childEnv });
    return stdout.trim();
}

/**
 * Imports the SDK's env loader in a child process and prints the marker.
 * @param {{cwd: string, env?: Record<string, string|undefined>}} arg0
 * @returns {Promise<string>}
 */
async function markerFrom({ cwd, env = {} }) {
    const script = `const m = await import(${JSON.stringify(UTILS_URL)}); m.ensureEnvLoaded(); process.stdout.write(String(process.env.MERCI_ENV_FILE_LOCATION_TEST ?? 'unset'));`;
    return runChild({ cwd, script, env });
}

test('secret.env resolves from the consumer project', async () => {
    const project = await mkdtemp(join(tmpdir(), 'merci-env-project-'));
    try {
        await writeFile(join(project, 'secret.env'), 'MERCI_ENV_FILE_LOCATION_TEST=from-project\n');
        assert.equal(await markerFrom({ cwd: project }), 'from-project');
    } finally {
        await rm(project, { recursive: true, force: true });
    }
});

test('MERCI_ENV_FILE names the file explicitly', async () => {
    const project = await mkdtemp(join(tmpdir(), 'merci-env-project-'));
    const elsewhere = await mkdtemp(join(tmpdir(), 'merci-env-file-'));
    try {
        const explicit = join(elsewhere, 'custom.env');
        await writeFile(explicit, 'MERCI_ENV_FILE_LOCATION_TEST=from-override\n');
        assert.equal(await markerFrom({ cwd: project, env: { MERCI_ENV_FILE: explicit } }), 'from-override');
    } finally {
        await rm(project, { recursive: true, force: true });
        await rm(elsewhere, { recursive: true, force: true });
    }
});

test('a discovered project file is never the persistence target', async () => {
    const project = await mkdtemp(join(tmpdir(), 'merci-env-project-'));
    try {
        await writeFile(join(project, 'secret.env'), 'JAI_TOKEN=old-project\n');
        const script = `
            const { loadCredentials } = await import(${JSON.stringify(UTILS_URL)});
            const creds = loadCredentials({ provider: 'jai' });
            process.stdout.write(String(creds.tokenPersistFile));
        `;
        const target = await runChild({ cwd: project, script });

        assert.equal(target, fileURLToPath(new URL('../secret.env', import.meta.url)), 'persistence falls back to the package-relative file');
        assert.notEqual(target, join(project, 'secret.env'), 'finding a project file is not permission to write a bearer token into it');
    } finally {
        await rm(project, { recursive: true, force: true });
    }
});

test('an empty cwd falls back to the package checkout', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'merci-env-empty-'));
    try {
        const script = `const m = await import(${JSON.stringify(UTILS_URL)}); process.stdout.write(m.envFilePath());`;
        const resolved = await runChild({ cwd: empty, script });
        assert.equal(resolved, fileURLToPath(new URL('../secret.env', import.meta.url)), 'the package-relative file is the last resort');
        assert.notEqual(resolved, join(empty, 'secret.env'), 'an empty cwd has no project file to find');
    } finally {
        await rm(empty, { recursive: true, force: true });
    }
});

test('a refreshed token is written only to the explicitly chosen file', async () => {
    const project = await mkdtemp(join(tmpdir(), 'merci-env-project-'));
    const persistDir = await mkdtemp(join(tmpdir(), 'merci-env-persist-'));
    try {
        const projectFile = join(project, 'secret.env');
        const projectBody = 'JAI_TOKEN=old-project\nKEEP=1\n';
        await writeFile(projectFile, projectBody);
        const persistFile = join(persistDir, 'secret.env');
        await writeFile(persistFile, 'JAI_TOKEN=old-explicit\n');

        const script = `
            const { EventEmitter } = await import('node:events');
            const { loadCredentials } = await import(${JSON.stringify(UTILS_URL)});
            const { InternalHttpClient } = await import(${JSON.stringify(HTTP_CLIENT_URL)});
            globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ token: 'fresh-jwt' }) });
            const creds = loadCredentials({ provider: 'jai' });
            const client = new InternalHttpClient({ options: { token: 'expired', tokenPersistFile: creds.tokenPersistFile, tokenPersistKey: creds.tokenPersistKey }, eventEmitter: new EventEmitter() });
            await client.refreshToken();
            process.stdout.write(String(creds.tokenPersistFile));
        `;
        const target = await runChild({ cwd: project, script, env: { MERCI_ENV_FILE: persistFile } });

        assert.equal(target, persistFile, 'persistence follows the explicitly chosen file');
        assert.match(await readFile(persistFile, 'utf8'), /^JAI_TOKEN=fresh-jwt$/m);
        assert.equal(await readFile(projectFile, 'utf8'), projectBody, 'the discovered project file is never written');
    } finally {
        await rm(project, { recursive: true, force: true });
        await rm(persistDir, { recursive: true, force: true });
    }
});

test('the resolved env file is cached for the process', async () => {
    const projectA = await mkdtemp(join(tmpdir(), 'merci-env-a-'));
    const projectB = await mkdtemp(join(tmpdir(), 'merci-env-b-'));
    try {
        await writeFile(join(projectA, 'secret.env'), 'MERCI_ENV_FILE_LOCATION_TEST=from-a\n');
        await writeFile(join(projectB, 'secret.env'), 'MERCI_ENV_FILE_LOCATION_TEST=from-b\n');
        await writeFile(join(projectA, 'sa.json'), JSON.stringify({ project_id: 'project-a' }));
        await writeFile(join(projectB, 'sa.json'), JSON.stringify({ project_id: 'project-b' }));

        const script = `
            const { ensureEnvLoaded, envFilePath, loadCredentials } = await import(${JSON.stringify(UTILS_URL)});
            ensureEnvLoaded();
            const first = envFilePath();
            process.chdir(${JSON.stringify(projectB)});
            const after = envFilePath();
            const vertex = loadCredentials({ provider: 'vertex' });
            process.stdout.write(JSON.stringify({ first, after, project: vertex.genaiOptions.project, marker: process.env.MERCI_ENV_FILE_LOCATION_TEST }));
        `;
        /** @type {{first: string, after: string, project: string, marker: string}} */
        const seen = JSON.parse(await runChild({ cwd: projectA, script, env: { VERTEX_CREDENTIALS: 'sa.json' } }));

        assert.equal(seen.first, await realpath(join(projectA, 'secret.env')), 'the first lookup wins');
        assert.equal(seen.marker, 'from-a', 'the loaded file is the one A');
        assert.equal(seen.after, seen.first, 'a later chdir does not re-resolve the file');
        assert.equal(seen.project, 'project-a', 'the credentials dir follows the loaded file, not the new cwd');
    } finally {
        await rm(projectA, { recursive: true, force: true });
        await rm(projectB, { recursive: true, force: true });
    }
});
