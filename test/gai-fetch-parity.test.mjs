// @ts-check
/**
 * @file Replay parity: the native GAI connector against recorded SDK fixtures.
 * @version 0.22.0
 *
 * @description
 * Reads `test/fixtures/gai-parity/manifest.json`, asserts the recorded case ids
 * match `cases.mjs` exactly, then replays every case against a loopback server
 * using `createGaiTransport` — never the `@google/genai` SDK — and compares the
 * requests and the observation. A failure is a real behavioural divergence.
 * The closing section replays `getProfiles()` and `embed()` through a real
 * `MerciClient`, so the client's wiring is under the same assertion.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { CASES } from './gai-parity/cases.mjs';
import { startServer } from './gai-parity/server.mjs';
import { compareCase, formatDiff, normalizeRequests } from './gai-parity/compare.mjs';
import { createGaiTransport } from '../lib/backends/transport/gai-client.mjs';
import { MerciClient } from '../lib/backends/gai.mjs';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/gai-parity/', import.meta.url));
const CASE_IDS = CASES.map((caseDef) => caseDef.id).sort();
const DEFAULT_API_KEY = 'test-api-key';

let passed = 0;
/** @type {Array<string>} */
const failed = [];

/**
 * Reads one fixture by case id.
 * @param {{id: string}} arg0
 * @returns {Promise<any>}
 */
async function readFixture({ id }) {
    return JSON.parse(await readFile(join(FIXTURE_DIR, `${id}.json`), 'utf8'));
}

/**
 * Reduces a thrown value to the comparable wire fields, as the recorder did.
 * @param {any} error
 * @returns {{name: string|null, message: string|null, status: any, code: any, error: any, causeName: string|null}}
 */
function projectError(error) {
    const e = error && typeof error === 'object' ? error : {};
    return {
        name: e.name ?? null,
        message: typeof e.message === 'string' ? e.message : (e.message == null ? null : String(e.message)),
        status: e.status ?? null,
        code: e.code ?? null,
        error: e.error === undefined ? null : jsonValue({ value: e.error }),
        causeName: e.cause?.name ?? null,
    };
}

/**
 * JSON projection, matching the observation shape.
 * @param {{value: any}} arg0
 * @returns {any}
 */
function jsonValue({ value }) {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/**
 * The transport one case is replayed with: the SDK client options, but with
 * the loopback root as `baseURL` and an API key (never a real credential).
 * @param {{case: any, baseURL: string}} arg0
 * @returns {Record<string, any>}
 */
function transportFor({ case: caseDef, baseURL }) {
    const client = caseDef.client ?? {};
    return createGaiTransport({
        apiKey: client.apiKey ?? DEFAULT_API_KEY,
        ...(client.vertexai ? { vertexai: true, project: client.project, location: client.location } : {}),
        ...(client.apiVersion ? { apiVersion: client.apiVersion } : {}),
        baseURL,
        ...(client.defaultHeaders ? { defaultHeaders: client.defaultHeaders } : {}),
    });
}

/**
 * Collects one stream, aborting the caller's signal when the case asks.
 * @param {{transport: Record<string, any>, case: any}} arg0
 * @returns {Promise<any>}
 */
async function observeStream({ transport, case: caseDef }) {
    const { model, contents, config } = caseDef.request;
    const abortAfter = caseDef.mode === 'abort' ? (caseDef.abortAfter ?? 1) : 0;
    const controller = abortAfter > 0 ? new AbortController() : null;
    const callConfig = controller ? { ...(config ?? {}), abortSignal: controller.signal } : config;
    const stream = await transport.models.generateContentStream({ model, contents, ...(callConfig ? { config: callConfig } : {}) });

    /** @type {Array<any>} */
    const chunks = [];
    /** @type {'clean'|'threw'} */
    let ended = 'clean';
    /** @type {any} */
    let error;
    try {
        for await (const chunk of stream) {
            chunks.push({ json: jsonValue({ value: chunk }), text: chunk.text ?? null, functionCalls: chunk.functionCalls ?? null });
            if (controller && chunks.length >= abortAfter) controller.abort();
        }
    } catch (thrown) {
        ended = 'threw';
        error = projectError(thrown);
    }
    return { kind: 'chunks', chunks, ended, ...(error ? { error } : {}) };
}

/**
 * Walks every page of `models.list()`, so the paging request is part of the record.
 * @param {{transport: Record<string, any>}} arg0
 * @returns {Promise<any>}
 */
async function observeModels({ transport }) {
    const pager = await transport.models.list();
    const pages = [pager.page];
    while (pager.hasNextPage()) pages.push(await pager.nextPage());
    const models = pages.flat().map((/** @type {any} */ model) => jsonValue({ value: model }));
    return { kind: 'value', value: { models, pages: pages.length } };
}

/**
 * Runs `models.embedContent` and projects the response plus the derived values.
 * @param {{transport: Record<string, any>, case: any}} arg0
 * @returns {Promise<any>}
 */
async function observeEmbed({ transport, case: caseDef }) {
    const { model, contents, config } = caseDef.request;
    const response = await transport.models.embedContent({ model, contents, ...(config ? { config } : {}) });
    const embeddings = response.embeddings == null
        ? null
        : /** @type {Array<any>} */ (response.embeddings).map((entry) => entry.values);
    return {
        kind: 'value',
        value: jsonValue({ value: response }),
        embeddings,
        embedding: embeddings === null || embeddings.length === 0 ? null : embeddings[0],
    };
}

/**
 * Runs one case over the transport and returns the recorded observation shape.
 * @param {{case: any, transport: Record<string, any>}} arg0
 * @returns {Promise<any>}
 */
async function observe({ case: caseDef, transport }) {
    try {
        if (caseDef.kind === 'models') return await observeModels({ transport });
        if (caseDef.kind === 'embed') return await observeEmbed({ transport, case: caseDef });
        return await observeStream({ transport, case: caseDef });
    } catch (error) {
        return { kind: 'error', error: projectError(error) };
    }
}

test('fixture manifest matches the case matrix', async () => {
    const manifestText = await readFile(join(FIXTURE_DIR, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.sdkPackage, '@google/genai', 'the oracle records the SDK package');
    assert.equal(manifest.sdkVersion, '2.32.0', 'the oracle pins the SDK version');
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
            const fixture = await readFixture({ id: caseDef.id });
            assert.equal(fixture.case?.id, caseDef.id, 'fixture case id matches its filename');
            const server = await startServer({ case: caseDef });
            let outcome;
            try {
                const transport = transportFor({ case: caseDef, baseURL: server.baseURL });
                outcome = await observe({ case: caseDef, transport });
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
// The wiring, not just the module: a real MerciClient builds the transport, and
// `getProfiles()` / `embed()` must exchange the same wire shape the fixtures pin.
test('production client: getProfiles() over the transport', async () => {
    const caseDef = CASES.find((candidate) => candidate.id === 'models-list-single-page');
    assert.ok(caseDef, 'case models-list-single-page exists');
    const fixture = await readFixture({ id: caseDef.id });
    const server = await startServer({ case: caseDef });
    try {
        const client = new MerciClient({ options: { apiKey: DEFAULT_API_KEY, baseURL: server.baseURL } });
        const profiles = await client.getProfiles();
        assert.deepEqual(
            profiles,
            fixture.outcome.value.models.map((/** @type {any} */ model) => ({ id: model.name, name: model.displayName || model.name })),
        );
        assert.deepEqual(
            normalizeRequests({ requests: server.requests }),
            normalizeRequests({ requests: fixture.request }),
            'getProfiles() sends the fixture request',
        );
    } finally {
        await server.close();
    }
});

test('production client: embed() over the transport', async () => {
    const caseDef = CASES.find((candidate) => candidate.id === 'embed-batch');
    assert.ok(caseDef, 'case embed-batch exists');
    const fixture = await readFixture({ id: caseDef.id });
    const server = await startServer({ case: caseDef });
    try {
        const client = new MerciClient({ options: { apiKey: DEFAULT_API_KEY, baseURL: server.baseURL } });
        const vectors = await client.embed({ input: ['alpha', 'beta'], model: fixture.case.request.model });
        assert.deepEqual(vectors, fixture.outcome.embeddings);
        assert.deepEqual(
            normalizeRequests({ requests: server.requests }),
            normalizeRequests({ requests: fixture.request }),
            'embed() sends the fixture body',
        );
    } finally {
        await server.close();
    }
});

// The Vertex `:embedContent` answer is one embedding plus its statistics, not a
// `predictions` list: a `MerciClient` over that fixture must return the vector
// its default Vertex embedding model needs.
test('production client: Vertex embed() reads the :embedContent shape', async () => {
    const caseDef = CASES.find((candidate) => candidate.id === 'vertex-embed-embedcontent');
    assert.ok(caseDef, 'case vertex-embed-embedcontent exists');
    const fixture = await readFixture({ id: caseDef.id });
    const server = await startServer({ case: caseDef });
    try {
        const client = new MerciClient({
            options: {
                apiKey: DEFAULT_API_KEY,
                baseURL: server.baseURL,
                genaiOptions: { vertexai: true, project: fixture.case.client.project, location: fixture.case.client.location },
            },
        });
        const vector = await client.embed({ input: 'hello', model: fixture.case.request.model });
        assert.deepEqual(vector, fixture.outcome.embedding, 'the vector, not null');
        assert.deepEqual(
            normalizeRequests({ requests: server.requests }),
            normalizeRequests({ requests: fixture.request }),
            'embed() sends the fixture body',
        );

        const transport = /** @type {any} */ (client).transport;
        const response = await transport.models.embedContent({ model: fixture.case.request.model, contents: 'hello' });
        assert.deepEqual(
            response.embeddings[0].statistics,
            fixture.outcome.value.embeddings[0].statistics,
            'the statistics the SDK attaches to the single embedding',
        );
    } finally {
        await server.close();
    }
});
