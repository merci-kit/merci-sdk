// @ts-check
/**
 * @file Oracle recorder for the AAI wire-parity fixtures.
 * @version 0.21.1
 *
 * @description
 * Recording mode only: `AAI_ORACLE_RECORD=1` runs every case against the real
 * `@anthropic-ai/sdk` through a loopback server and writes
 * `test/fixtures/aai-parity/<id>.json` plus `manifest.json`. Without the flag
 * the whole file is skipped, so the normal suite stays offline.
 *
 * The fixtures are the differential oracle for the native Anthropic connector:
 * the request bytes the SDK sent, the response spec the server wrote, and what
 * the SDK made of it. Recording twice must produce byte-identical files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { CASES } from './aai-parity/cases.mjs';
import { startServer } from './aai-parity/server.mjs';
import { observe } from './aai-parity/observe.mjs';

const RECORD = process.env.AAI_ORACLE_RECORD === '1';
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/aai-parity/', import.meta.url));
const SDK_PACKAGE = '@anthropic-ai/sdk';
// The installed package's own package.json: the version is read from the file,
// not from a package export, so the manifest pins what is really on disk.
const SDK_PACKAGE_JSON = fileURLToPath(new URL('../node_modules/@anthropic-ai/sdk/package.json', import.meta.url));

/**
 * Runs `observe`, muting the SDK's own logger for the one case that provokes
 * malformed-SSE console.error lines. The SDK binds `console.error` on first
 * use, so reassigning it would not take; `logLevel: 'off'` is the supported
 * switch and is scoped to this case only.
 * @param {{case: any, baseURL: string}} arg0
 * @returns {Promise<any>}
 */
async function observeCase({ case: caseDef, baseURL }) {
    const quiet = caseDef.id === 'messages-stream-malformed-json';
    return observe({ case: caseDef, baseURL, ...(quiet ? { logLevel: 'off' } : {}) });
}

test('record AAI oracle fixtures', { skip: !RECORD }, async (t) => {
    try {
        // Runtime specifier: the SDK is optional, so the import must not be
        // resolved statically when the package is absent.
        /** @type {string} */
        const sdkModule = SDK_PACKAGE;
        await import(sdkModule);
    } catch {
        t.skip(`${SDK_PACKAGE} not installed (oracle recorder)`);
        return;
    }
    // Read outside the skip guard: an installed SDK with an unreadable
    // package.json is a broken recording setup, not a reason to skip.
    const VERSION = JSON.parse(await readFile(SDK_PACKAGE_JSON, 'utf8')).version;

    await mkdir(FIXTURE_DIR, { recursive: true });

    // Record every case in memory first: a failing case leaves the committed
    // fixtures untouched instead of a wiped, half-written directory.
    /** @type {Array<{id: string, fixture: any}>} */
    const recorded = [];
    for (const caseDef of CASES) {
        const server = await startServer({ case: caseDef });
        let outcome;
        try {
            outcome = await observeCase({ case: caseDef, baseURL: server.baseURL });
        } finally {
            await server.close();
        }
        recorded.push({
            id: caseDef.id,
            fixture: {
                case: caseDef,
                sdkVersion: VERSION,
                node: process.version,
                response: caseDef.responses ?? caseDef.response,
                request: server.requests,
                outcome,
            },
        });
    }

    const ids = recorded.map(({ id }) => id);
    for (const { id, fixture } of recorded) {
        await writeFile(join(FIXTURE_DIR, `${id}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    }
    await writeFile(
        join(FIXTURE_DIR, 'manifest.json'),
        `${JSON.stringify({ sdkPackage: SDK_PACKAGE, sdkVersion: VERSION, node: process.version, cases: ids }, null, 2)}\n`,
    );

    const written = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith('.json') && name !== 'manifest.json');
    for (const id of ids) assert.ok(written.includes(`${id}.json`), `fixture written for ${id}`);
    assert.equal(recorded.length, CASES.length, 'one fixture per case');
});
