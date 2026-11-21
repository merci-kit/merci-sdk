// @ts-check
/**
 * @file Oracle recorder for the GAI wire-parity fixtures.
 * @version 0.21.1
 *
 * @description
 * Recording mode only: `GAI_ORACLE_RECORD=1` runs every case against the real
 * `@google/genai` SDK through a loopback server and writes
 * `test/fixtures/gai-parity/<id>.json` plus `manifest.json`. Without the flag
 * the whole file is skipped, so the normal suite stays offline.
 *
 * The pinned SDK version is the one the wire declares in `user-agent`
 * (`google-genai-sdk/<version>`), which is also the header a native connector
 * has to reproduce. Every case must agree on it, so a stray second copy of the
 * package cannot silently split the fixtures.
 *
 * Every case is recorded in memory first: a failing case leaves the committed
 * fixtures untouched instead of a wiped, half-written directory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { CASES } from './gai-parity/cases.mjs';
import { startServer, normalizeRequests } from './gai-parity/server.mjs';
import { loadSdk, observe } from './gai-parity/observe.mjs';

const RECORD = process.env.GAI_ORACLE_RECORD === '1';
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/gai-parity/', import.meta.url));
const SDK_PACKAGE = '@google/genai';

/**
 * Runs `observe`, silencing the console methods a case declares it provokes
 * (the derived `text` getter warns about non-text parts).
 * @param {{case: any, baseUrl: string}} arg0
 * @returns {Promise<any>}
 */
async function observeCase({ case: caseDef, baseUrl }) {
    const quiet = /** @type {Array<string>} */ (caseDef.quiet ?? []);
    if (quiet.length === 0) return observe({ case: caseDef, baseUrl });
    const consoleIndex = /** @type {Record<string, any>} */ (console);
    /** @type {Map<string, any>} */
    const saved = new Map();
    for (const name of quiet) {
        saved.set(name, consoleIndex[name]);
        consoleIndex[name] = () => {};
    }
    try {
        return await observe({ case: caseDef, baseUrl });
    } finally {
        for (const [name, original] of saved) consoleIndex[name] = original;
    }
}

/**
 * Reads the SDK version out of the recorded `user-agent` header.
 * @param {Array<{headers: Record<string, string>}>} requests
 * @returns {string|null}
 */
function sdkVersionOf(requests) {
    for (const request of requests) {
        const match = /google-genai-sdk\/(\S+)/.exec(request.headers['user-agent'] ?? '');
        if (match) return match[1];
    }
    return null;
}

test('record GAI oracle fixtures', { skip: !RECORD }, async (t) => {
    try {
        await loadSdk();
    } catch {
        t.skip('@google/genai not installed (oracle recorder)');
        return;
    }

    await mkdir(FIXTURE_DIR, { recursive: true });

    /** @type {Array<{id: string, case: any, response: any, request: Array<any>, outcome: any}>} */
    const recorded = [];
    for (const caseDef of CASES) {
        const server = await startServer({ case: caseDef });
        let outcome;
        try {
            outcome = await observeCase({ case: caseDef, baseUrl: server.baseURL });
        } finally {
            await server.close();
        }
        recorded.push({
            id: caseDef.id,
            case: caseDef,
            response: caseDef.responses ?? caseDef.response,
            request: normalizeRequests({ requests: server.requests, extra: caseDef.compare?.requestHeaders ?? [] }),
            outcome,
        });
    }

    // A case that is refused before a request (the two-content embed) declares
    // no version; every case that does send one must agree on it.
    const versions = new Set(recorded.map(({ request }) => sdkVersionOf(request)).filter((version) => version !== null));
    assert.equal(versions.size, 1, 'one SDK version across every case');
    const [sdkVersion] = [...versions];
    assert.ok(sdkVersion, 'the SDK declares its version in the user-agent header');

    const ids = recorded.map(({ id }) => id);
    for (const { id, case: caseDef, response, request, outcome } of recorded) {
        const fixture = { case: caseDef, sdkPackage: SDK_PACKAGE, sdkVersion, node: process.version, response, request, outcome };
        await writeFile(join(FIXTURE_DIR, `${id}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    }
    await writeFile(join(FIXTURE_DIR, 'manifest.json'), `${JSON.stringify({ sdkPackage: SDK_PACKAGE, sdkVersion, node: process.version, cases: ids }, null, 2)}\n`);

    const written = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith('.json') && name !== 'manifest.json');
    for (const id of ids) assert.ok(written.includes(`${id}.json`), `fixture written for ${id}`);
    assert.equal(recorded.length, CASES.length, 'one fixture per case');
});
