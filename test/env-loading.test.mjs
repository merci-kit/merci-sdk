// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// A consumer imports the SDK and must never see output on stdout/stderr:
// dotenv >= 17 prints an "injected env" banner unless it is told to stay quiet.
test('loading the env file writes nothing to the consumer stdout or stderr', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
        '-e',
        "import('./lib/support/utils.mjs').then((m) => { m.ensureEnvLoaded(); });"
    ], { cwd: ROOT });
    assert.equal(stdout.trim(), '', 'the SDK must not print to a consumer stdout');
    assert.equal(stderr.trim(), '', 'the SDK must not print to a consumer stderr');
});
