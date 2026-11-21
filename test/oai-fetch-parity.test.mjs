// @ts-check
/**
 * @file Replay parity: the native OAI connector against recorded SDK fixtures.
 * @version 0.21.0
 *
 * @description
 * Reads `test/fixtures/oai-parity/manifest.json`, asserts the recorded case ids
 * match `cases.mjs` exactly, then replays every case against a loopback server
 * using `createOaiTransport` — never the `openai` SDK — and compares the
 * requests and the observation. A failure is a real behavioural divergence.
 * The closing section replays two cases through a real `MerciClient`, so the
 * client's wiring is under the same assertion.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { CASES } from './oai-parity/cases.mjs';
import { startServer } from './oai-parity/server.mjs';
import { observe } from './oai-parity/observe.mjs';
import { compareCase, formatDiff } from './oai-parity/compare.mjs';
import { createOaiTransport } from '../lib/backends/transport/oai-client.mjs';
import { MerciClient } from '../lib/backends/oai.mjs';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/oai-parity/', import.meta.url));
const CASE_IDS = CASES.map((caseDef) => caseDef.id).sort();

let passed = 0;
/** @type {Array<string>} */
const failed = [];

test('fixture manifest matches the case matrix', async () => {
    const manifestText = await readFile(join(FIXTURE_DIR, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    assert.equal(new Set(CASE_IDS).size, CASE_IDS.length, 'case ids are unique');
    assert.deepEqual([...manifest.cases].sort(), CASE_IDS, 'manifest ids must match cases.mjs');
    const files = (await readdir(FIXTURE_DIR))
        .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
        .map((name) => name.slice(0, -'.json'.length))
        .sort();
    assert.deepEqual(files, CASE_IDS, 'one fixture per case, no extras');
});

for (const caseDef of CASES) {
    test(`replay ${caseDef.id}`, async () => {
        try {
            const fixture = JSON.parse(await readFile(join(FIXTURE_DIR, `${caseDef.id}.json`), 'utf8'));
            assert.equal(fixture.case?.id, caseDef.id, 'fixture case id matches its filename');
            const server = await startServer({ case: caseDef });
            let outcome;
            try {
                const baseURL = `${server.baseURL}/v1`;
                const transport = createOaiTransport({
                    apiKey: 'test-key',
                    baseURL,
                    ...(caseDef.client?.defaultHeaders ? { defaultHeaders: caseDef.client.defaultHeaders } : {}),
                });
                outcome = await observe({ case: caseDef, transport, baseURL });
            } finally {
                await server.close();
            }
            const diffs = compareCase({ case: caseDef, expected: fixture, actual: { request: server.requests, outcome } });
            if (diffs.length > 0) {
                assert.fail(`${caseDef.id}: ${diffs.length} diff(s); first ${formatDiff(diffs[0])}`);
            }
            passed += 1;
        } catch (error) {
            failed.push(caseDef.id);
            throw error;
        }
    });
}

test('summary', () => {
    console.log(failed.length === 0
        ? `${passed}/${CASES.length} cases, 0 diffs`
        : `${passed}/${CASES.length} cases, ${failed.length} failing`);
    assert.equal(failed.length, 0, `failing cases: ${failed.join(', ')}`);
});

// ── production transport ────────────────────────────────────────────────────
// The wiring, not just the module: a real MerciClient builds the transport, and
// the same fixture must still match.
for (const id of ['chat-stream-text-usage-stop', 'responses-json-full-no-output-text']) {
    test(`production transport: ${id}`, async () => {
        const caseDef = CASES.find((candidate) => candidate.id === id);
        assert.ok(caseDef, `case ${id} exists`);
        const fixture = JSON.parse(await readFile(join(FIXTURE_DIR, `${id}.json`), 'utf8'));
        const server = await startServer({ case: caseDef });
        let outcome;
        try {
            const baseURL = `${server.baseURL}/v1`;
            const client = new MerciClient({ options: { apiKey: 'test-key', baseURL } });
            const transport = /** @type {any} */ (client).transport;
            assert.equal(transport.baseURL, baseURL, 'the client built the loopback transport');
            outcome = await observe({ case: caseDef, transport, baseURL });
        } finally {
            await server.close();
        }
        const diffs = compareCase({ case: caseDef, expected: fixture, actual: { request: server.requests, outcome } });
        assert.equal(diffs.length, 0, `${id}: ${diffs.length} diff(s); first ${diffs.length ? formatDiff(diffs[0]) : ''}`);
    });
}
