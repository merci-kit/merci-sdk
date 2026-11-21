// @ts-check
/**
 * @file Oracle recorder for the OAI wire-parity fixtures.
 * @version 0.21.0
 *
 * @description
 * Recording mode only: `OAI_ORACLE_RECORD=1` runs every case against the real
 * `openai` SDK through a loopback server and writes
 * `test/fixtures/oai-parity/<id>.json` plus `manifest.json`. Without the flag
 * the whole file is skipped, so the normal suite stays offline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { CASES } from './oai-parity/cases.mjs';
import { startServer } from './oai-parity/server.mjs';
import { observe } from './oai-parity/observe.mjs';
import { normalizeRequests } from './oai-parity/compare.mjs';

const RECORD = process.env.OAI_ORACLE_RECORD === '1';
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/oai-parity/', import.meta.url));

/**
 * Runs `observe`, silencing the SDK's malformed-SSE console.error lines for the
 * one case that provokes them.
 * @param {{case: any, transport: any, baseURL: string}} arg0
 * @returns {Promise<any>}
 */
async function observeCase({ case: caseDef, transport, baseURL }) {
    if (caseDef.id !== 'chat-stream-malformed') return observe({ case: caseDef, transport, baseURL });
    const original = console.error;
    console.error = () => {};
    try {
        return await observe({ case: caseDef, transport, baseURL });
    } finally {
        console.error = original;
    }
}

test('record OAI oracle fixtures', { skip: !RECORD }, async (t) => {
    /** @type {any} */
    let OpenAI;
    /** @type {any} */
    let VERSION;
    try {
        // Runtime specifiers: `openai` is optional, so the import must not be
        // resolved statically when the package is absent.
        /** @type {string} */
        const openaiModule = 'openai';
        /** @type {string} */
        const openaiVersionModule = 'openai/version.mjs';
        OpenAI = (await import(openaiModule)).default;
        VERSION = (await import(openaiVersionModule)).VERSION;
    } catch {
        t.skip('openai not installed (oracle recorder)');
        return;
    }

    await mkdir(FIXTURE_DIR, { recursive: true });

    // Record every case in memory first: a failing case leaves the committed
    // fixtures untouched instead of a wiped, half-written directory.
    /** @type {Array<{id: string, fixture: any}>} */
    const recorded = [];
    for (const caseDef of CASES) {
        const server = await startServer({ case: caseDef });
        let outcome;
        try {
            const baseURL = `${server.baseURL}/v1`;
            const transport = new OpenAI({
                apiKey: caseDef.client?.apiKey ?? 'test-key',
                baseURL,
                maxRetries: 0,
                ...(caseDef.client?.defaultHeaders ? { defaultHeaders: caseDef.client.defaultHeaders } : {}),
            });
            outcome = await observeCase({ case: caseDef, transport, baseURL });
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
                request: normalizeRequests({ requests: server.requests, extra: caseDef.compare?.requestHeaders ?? [] }),
                outcome,
            },
        });
    }

    const ids = recorded.map(({ id }) => id);
    for (const { id, fixture } of recorded) {
        await writeFile(join(FIXTURE_DIR, `${id}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    }
    await writeFile(join(FIXTURE_DIR, 'manifest.json'), `${JSON.stringify({ sdkVersion: VERSION, node: process.version, cases: ids }, null, 2)}\n`);

    const written = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith('.json') && name !== 'manifest.json');
    for (const id of ids) assert.ok(written.includes(`${id}.json`), `fixture written for ${id}`);
    assert.equal(recorded.length, CASES.length, 'one fixture per case');
});
