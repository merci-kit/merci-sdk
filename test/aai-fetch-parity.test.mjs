// @ts-check
/**
 * @file Replay parity: the native Anthropic connector against recorded SDK fixtures.
 * @version 0.22.0
 *
 * @description
 * Reads `test/fixtures/aai-parity/manifest.json`, asserts the recorded case ids
 * match `cases.mjs` exactly, then replays every case against a loopback server
 * using `createAaiTransport` — never `@anthropic-ai/sdk` — and compares the
 * requests and the observation. A failure is a real behavioural divergence.
 * The closing section replays the models cases through a real `MerciClient`
 * (`getProfiles`, success and 401) and proves `embed()` never reaches the wire.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { CASES } from './aai-parity/cases.mjs';
import { startServer } from './aai-parity/server.mjs';
import { observeNative } from './aai-parity/native-observe.mjs';
import { compareCase, formatDiff, pickRequestHeaders } from './aai-parity/compare.mjs';
import { createAaiTransport } from '../lib/backends/transport/aai-client.mjs';
import { MerciClient } from '../lib/backends/aai.mjs';
import { BackendError, ConfigurationError } from '../lib/core/errors.mjs';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/aai-parity/', import.meta.url));
const CASE_IDS = CASES.map((caseDef) => caseDef.id).sort();

let passed = 0;
/** @type {Array<string>} */
const failed = [];

test('fixture manifest matches the case matrix', async () => {
    const manifestText = await readFile(join(FIXTURE_DIR, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    // Literal, so a re-record against a different SDK version fails here instead
    // of silently re-baselining every fixture.
    assert.equal(manifest.sdkPackage, '@anthropic-ai/sdk', 'the oracle records the SDK package');
    assert.equal(manifest.sdkVersion, '1.5.0', 'the oracle pins the SDK version');
    assert.equal(new Set(CASE_IDS).size, CASE_IDS.length, 'case ids are unique');
    assert.deepEqual([...manifest.cases].sort(), CASE_IDS, 'manifest ids must match cases.mjs');
    const files = (await readdir(FIXTURE_DIR))
        .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
        .map((name) => name.slice(0, -'.json'.length))
        .sort();
    assert.deepEqual(files, CASE_IDS, 'one fixture per case, no extras');
});

/**
 * A transport whose fetch records the response status, standing in for the
 * SDK's `stream.response.status`.
 * @param {{baseURL: string}} arg0
 * @returns {{transport: any, statusOf: () => number|null}}
 */
function recordingTransport({ baseURL }) {
    /** @type {number|null} */
    let status = null;
    const transport = createAaiTransport({
        apiKey: 'test-key',
        baseURL,
        /** @type {typeof fetch} */
        fetch: async (url, init) => {
            const response = await fetch(url, init);
            status = response.status;
            return response;
        },
    });
    return { transport, statusOf: () => status };
}

for (const caseDef of CASES) {
    test(`replay ${caseDef.id}`, async () => {
        try {
            const fixture = JSON.parse(await readFile(join(FIXTURE_DIR, `${caseDef.id}.json`), 'utf8'));
            assert.equal(fixture.case?.id, caseDef.id, 'fixture case id matches its filename');
            const server = await startServer({ case: caseDef });
            let outcome;
            try {
                const { transport, statusOf } = recordingTransport({ baseURL: server.baseURL });
                outcome = await observeNative({ case: caseDef, transport, statusOf });
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

// ── production client ───────────────────────────────────────────────────────
// The wiring, not just the module: a real MerciClient builds the transport.
test('production client: getProfiles replays the models page', async () => {
    const caseDef = CASES.find((candidate) => candidate.id === 'models-list-single-page');
    assert.ok(caseDef, 'case models-list-single-page exists');
    const server = await startServer({ case: caseDef });
    try {
        const client = new MerciClient({ options: { apiKey: 'test-key', baseURL: server.baseURL } });
        const profiles = await client.getProfiles();
        assert.deepEqual(profiles, [
            { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
            { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
        ]);
        assert.equal(server.requests.length, 1, 'one request');
        assert.equal(server.requests[0].url, '/v1/models');
        const headers = pickRequestHeaders({ headers: server.requests[0].headers });
        assert.equal(headers.authorization, 'Bearer test-key');
        assert.equal(headers['anthropic-version'], '2026-10-21');
    } finally {
        await server.close();
    }
});

test('production client: getProfiles maps a 401 to AUTH_FAILURE', async () => {
    const caseDef = CASES.find((candidate) => candidate.id === 'models-list-http-401');
    assert.ok(caseDef, 'case models-list-http-401 exists');
    const server = await startServer({ case: caseDef });
    try {
        const client = new MerciClient({ options: { apiKey: 'test-key', baseURL: server.baseURL } });
        await assert.rejects(client.getProfiles(), (/** @type {any} */ error) => {
            assert.ok(error instanceof BackendError, 'a BackendError');
            assert.equal(error.code, 'AUTH_FAILURE');
            assert.equal(error.status, 401);
            assert.equal(server.requests.length, 1, 'one request');
            return true;
        });
    } finally {
        await server.close();
    }
});

test('production client: embed() throws without sending a request', async () => {
    const caseDef = CASES.find((candidate) => candidate.id === 'models-list-single-page');
    assert.ok(caseDef, 'a server case exists');
    const server = await startServer({ case: caseDef });
    try {
        const client = new MerciClient({ options: { apiKey: 'test-key', baseURL: server.baseURL } });
        await assert.rejects(client.embed({ input: 'hello' }), ConfigurationError);
        assert.equal(server.requests.length, 0, 'no request reached the wire');
    } finally {
        await server.close();
    }
});
