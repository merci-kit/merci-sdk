// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    MemoryProvider,
    LocalFileMemoryProvider,
    CompositeMemoryProvider,
} from '../lib/agentic/memory/providers.mjs';
import { cosineSimilarity, isEmbeddingUnsupportedStatus, grpcToHttpStatus } from '../lib/support/utils.mjs';
import { MerciClient as OaiClient } from '../lib/backends/oai.mjs';
import { MerciClient as GaiClient } from '../lib/backends/gai.mjs';
import './embed-env.mjs';

const BASIS = /** @type {Record<string, number[]>} */ ({
    car: [1, 0.9, 0, 0, 0, 0],
    automobile: [0.9, 1, 0, 0, 0, 0],
    engine: [0.5, 0.4, 0, 0, 0, 0],
    speed: [0, 0.5, 0.4, 0, 0, 0],
    driving: [0, 0, 1, 0, 0, 0],
    recipe: [0, 0, 0, 1, 0, 0],
    pie: [0, 0, 0.5, 0.9, 0, 0],
});

/** @param {{dim?: *}} arg0 */
function makeEmbedder({ dim = 6 } = {}) {
    const calls = /** @type {any[]} */ ([]);
    const embed = (/** @type {string} */ text) => {
        calls.push(text);
        const v = new Array(dim).fill(0);
        for (const w of String(text).toLowerCase().split(/\s+/)) {
            const b = BASIS[w];
            if (b) for (let i = 0; i < b.length && i < dim; i++) v[i] += b[i];
        }
        return v;
    };
    embed.calls = calls;
    return embed;
}

/** @param {{options?: *}} arg0 */
function makeProvider({ options = {} } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'merci-vec-'));
    const filePath = join(dir, 'memory.json');
    const provider = new LocalFileMemoryProvider({ options: { filePath, name: 'test', ...options } });
    return { provider, filePath, dir };
}

describe('cosineSimilarity', () => {
    it('is 1 for identical directions and 0 for orthogonal vectors', () => {
        assert.equal(cosineSimilarity({ a: [1, 0], b: [1, 0] }), 1);
        assert.equal(cosineSimilarity({ a: [1, 0], b: [0, 1] }), 0);
    });
    it('handles empty and zero vectors without NaN', () => {
        assert.equal(cosineSimilarity({ a: [], b: [] }), 0);
        assert.equal(cosineSimilarity({ a: [0, 0], b: [1, 1] }), 0);
        assert.ok(!Number.isNaN(cosineSimilarity({ a: [1, 1], b: [1, 1] })));
    });
});

describe('MemoryProvider.embed() base contract', () => {
    it('is a no-op returning null (backends without embeddings degrade gracefully)', async () => {
        assert.equal(await new MemoryProvider().embed('anything'), null);
    });
});

describe('embed() failure classification', () => {
    it('isEmbeddingUnsupportedStatus: 405/501 always soft-fail; 404 only for gateway-HTML bodies', () => {
        for (const s of [405, 501]) assert.equal(isEmbeddingUnsupportedStatus({ status: s, message: '' }), true, `status ${s}`);
        assert.equal(isEmbeddingUnsupportedStatus({ status: 404, message: '<!DOCTYPE html><html>404 - Page Not Found</html>' }), true, 'gateway HTML 404 = no /embeddings route');
        assert.equal(isEmbeddingUnsupportedStatus({ status: 404, message: 'Error code: 404 - The model \'x\' does not exist' }), false, 'API JSON 404 = unknown embedding model, must stay loud');
        assert.equal(isEmbeddingUnsupportedStatus({ status: 404 }), false, 'a bare 404 without an HTML body is genuine');
        for (const s of [400, 401, 403, 429, 500, 502, null, undefined]) assert.equal(isEmbeddingUnsupportedStatus({ status: /** @type {any} */ (s), message: '<html>' }), false, `status ${s}`);
    });

    it('an endpoint without an embeddings route soft-fails to null (no client error event) — OAI', async () => {
        const client = /** @type {any} */ (new OaiClient({ options: { apiKey: 'test-key', baseURL: 'https://example.test/v1' } }));
        client.transport.embeddings = { create: async () => { throw Object.assign(new Error('<html>404 page</html>'), { status: 404 }); } };
        let errors = 0;
        client.on('error', () => { errors++; });
        assert.equal(await client.embed({ input: 'hello' }), null, 'an unsupported endpoint must degrade gracefully');
        assert.equal(errors, 0, 'no client error event for an endpoint that has no embeddings route');
    });

    it('a genuine API 404 (unknown embedding model) still emits the client error and throws — OAI', async () => {
        const client = /** @type {any} */ (new OaiClient({ options: { apiKey: 'test-key', baseURL: 'https://example.test/v1', embedMaxRetries: 0 } }));
        client.transport.embeddings = { create: async () => { throw Object.assign(new Error('Error code: 404 - The model \'text-embedding-xyz\' does not exist'), { status: 404 }); } };
        let errors = 0;
        client.on('error', () => { errors++; });
        await assert.rejects(client.embed({ input: 'hello' }), /does not exist/);
        assert.equal(errors, 1, 'a model-not-found 404 is a genuine embed failure and must stay loud');
    });

    it('a Google-style gRPC NOT_FOUND (5) with a gateway HTML body soft-fails to null — GAI', async () => {
        const client = /** @type {any} */ (new GaiClient({ options: { apiKey: 'test-key' } }));
        client.transport.models = { embedContent: async () => { throw Object.assign(new Error('<html>404 page</html>'), { code: 5 }); } };
        let errors = 0;
        client.on('error', () => { errors++; });
        assert.equal(await client.embed({ input: 'hello' }), null, 'gRPC NOT_FOUND must map to the soft-fail set');
        assert.equal(errors, 0, 'no client error event for a gRPC-coded no-route endpoint');
    });

    it('a Google-style gRPC UNIMPLEMENTED (12) soft-fails to null — GAI', async () => {
        const client = /** @type {any} */ (new GaiClient({ options: { apiKey: 'test-key' } }));
        client.transport.models = { embedContent: async () => { throw Object.assign(new Error('<html>501 not implemented</html>'), { code: 12 }); } };
        let errors = 0;
        client.on('error', () => { errors++; });
        assert.equal(await client.embed({ input: 'hello' }), null, 'gRPC UNIMPLEMENTED must map to the soft-fail set');
        assert.equal(errors, 0, 'no client error event for a gRPC-coded no-route endpoint');
    });

    it('a gRPC-coded genuine failure (PERMISSION_DENIED 7) stays loud and throws — GAI', async () => {
        const client = /** @type {any} */ (new GaiClient({ options: { apiKey: 'test-key' } }));
        client.transport.models = { embedContent: async () => { throw Object.assign(new Error('permission denied'), { code: 7 }); } };
        let errors = 0;
        client.on('error', () => { errors++; });
        await assert.rejects(client.embed({ input: 'hello' }), /permission denied/);
        assert.equal(errors, 1, 'gRPC codes outside the soft-fail set must stay loud');
    });

    it('an endpoint without an embeddings route soft-fails to null — GAI mirrors the contract', async () => {
        const client = /** @type {any} */ (new GaiClient({ options: { apiKey: 'test-key' } }));
        client.transport.models = { embedContent: async () => { throw Object.assign(new Error('<html>404 page</html>'), { status: 404 }); } };
        let errors = 0;
        client.on('error', () => { errors++; });
        assert.equal(await client.embed({ input: 'hello' }), null, 'an unsupported endpoint must degrade gracefully');
        assert.equal(errors, 0, 'no client error event for an endpoint that has no embeddings route');
    });

    it('a genuine embed failure still emits the client error and throws', async () => {
        const client = /** @type {any} */ (new OaiClient({ options: { apiKey: 'test-key', baseURL: 'https://example.test/v1', embedMaxRetries: 0 } }));
        client.transport.embeddings = { create: async () => { throw Object.assign(new Error('quota exhausted'), { status: 429 }); } };
        let errors = 0;
        client.on('error', () => { errors++; });
        await assert.rejects(client.embed({ input: 'hello' }), /quota exhausted/);
        assert.equal(errors, 1, 'genuine failures must stay loud');
    });
});

describe('embed() telemetry terminals', () => {
    it('every non-throw path closes EMBED_START with an EMBED_FINISH — soft-fail (OAI)', async () => {
        const client = /** @type {any} */ (new OaiClient({ options: { apiKey: 'test-key', baseURL: 'https://example.test/v1' } }));
        client.transport.embeddings = { create: async () => { throw Object.assign(new Error('<html>404 page</html>'), { status: 404 }); } };
        const events = /** @type {any[]} */ ([]);
        client.on('embed_start', (/** @type {any} */ e) => events.push(['start', e.vectorLen]));
        client.on('embed_finish', (/** @type {any} */ e) => events.push(['finish', e.vectorLen]));
        assert.equal(await client.embed({ input: 'hello' }), null);
        assert.equal(events.length, 2, 'start + finish must both fire');
        assert.equal(events[0][0], 'start');
        assert.equal(events[1][0], 'finish');
        assert.equal(events[1][1], 0, 'a no-vector soft-fail closes with vectorLen 0');
    });

    it('every non-throw path closes EMBED_START with an EMBED_FINISH — soft-fail (GAI)', async () => {
        const client = /** @type {any} */ (new GaiClient({ options: { apiKey: 'test-key' } }));
        client.transport.models = { embedContent: async () => { throw Object.assign(new Error('<html>404 page</html>'), { status: 404 }); } };
        const events = /** @type {any[]} */ ([]);
        client.on('embed_start', (/** @type {any} */ e) => events.push(['start']));
        client.on('embed_finish', (/** @type {any} */ e) => events.push(['finish', e.vectorLen]));
        assert.equal(await client.embed({ input: 'hello' }), null);
        assert.equal(events.length, 2, 'start + finish must both fire');
        assert.equal(events[1][1], 0, 'a no-vector soft-fail closes with vectorLen 0');
    });

    it('a successful embed closes with vectorLen N — OAI', async () => {
        const client = /** @type {any} */ (new OaiClient({ options: { apiKey: 'test-key', baseURL: 'https://example.test/v1' } }));
        client.transport.embeddings = { create: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) };
        const events = /** @type {any[]} */ ([]);
        client.on('embed_start', (/** @type {any} */ e) => events.push(['start']));
        client.on('embed_finish', (/** @type {any} */ e) => events.push(['finish', e.vectorLen]));
        const vector = await client.embed({ input: 'hello' });
        assert.deepEqual(vector, [0.1, 0.2, 0.3]);
        assert.equal(events.length, 2, 'start + finish must both fire');
        assert.equal(events[1][1], 3, 'a real vector closes with its length');
    });

    it('a thrown embed does NOT emit embed_finish (the error event is the terminal)', async () => {
        const client = /** @type {any} */ (new OaiClient({ options: { apiKey: 'test-key', baseURL: 'https://example.test/v1', embedMaxRetries: 0 } }));
        client.transport.embeddings = { create: async () => { throw Object.assign(new Error('quota exhausted'), { status: 429 }); } };
        let finishes = 0;
        client.on('embed_finish', () => { finishes++; });
        await assert.rejects(client.embed({ input: 'hello' }), /quota exhausted/);
        assert.equal(finishes, 0, 'a genuine throw must not double-terminate with a finish');
    });
});

describe('vector retrieval tier', () => {
    it('ranks by cosine similarity with a .score, catching synonyms lexical misses', async () => {
        const { provider } = makeProvider({ options: { embedder: makeEmbedder() } });
        await provider.store({ content: 'automobile speed', category: 'general' });
        await provider.store({ content: 'recipe for pie', category: 'cooking' });
        const results = /** @type {any[]} */ (await provider.query({ text: 'car' }));
        assert.ok(results.length > 0);
        assert.equal(results[0].content, 'automobile speed', 'vector tier must catch the car/automobile synonym');
        assert.ok(typeof results[0].score === 'number' && results[0].score > 0.5,
            'vector matches carry a similarity score the composite sorts on');
    });

    it('falls back to the lexical tier when the embedder returns null', async () => {
        const { provider } = makeProvider({ options: { embedder: async () => null } });
        await provider.store({ content: 'engine part', category: 'general' });
        const results = /** @type {any[]} */ (await provider.query({ text: 'engine' }));
        assert.equal(results[0].content, 'engine part');
        assert.equal(results[0].score, 1, 'lexical tier scores are overlap ratios in (0,1] — 1 = full token overlap');
    });

    it('falls back to lexical/recency on a dimension mismatch instead of crashing', async () => {
        const { provider } = makeProvider({ options: { embedder: makeEmbedder() } });
        await provider.store({ content: 'engine part', category: 'general' });
        provider.embedder = makeEmbedder({ dim: 8 });
        const results = /** @type {any[]} */ (await provider.query({ text: 'engine' }));
        assert.ok(results.length > 0);
        assert.ok(results[0].content === 'engine part', 'dimension mismatch must not drop the bank');
    });
});

describe('embedding persistence', () => {
    it('persists embedding + dimension per fact and round-trips through the file', async () => {
        const { provider, filePath } = makeProvider({ options: { embedder: makeEmbedder() } });
        await provider.store({ content: 'automobile speed', category: 'general' });
        const stored = provider.facts[0];
        assert.ok(Array.isArray(stored.embedding), 'store() must attach the embedding');
        assert.equal(stored.dimension, 6);

        const reloaded = new LocalFileMemoryProvider({ options: { filePath, name: 'test', embedder: makeEmbedder() } });
        await reloaded.load();
        assert.deepEqual(reloaded.facts[0].embedding, stored.embedding);
        assert.equal(reloaded.facts[0].dimension, 6);
    });

    it('backfills missing embeddings lazily on query', async () => {
        const { provider, filePath } = makeProvider();
        await provider.store({ content: 'automobile speed', category: 'general' });
        const embedder = makeEmbedder();
        const reloaded = new LocalFileMemoryProvider({ options: { filePath, name: 'test', embedder } });
        await reloaded.load();
        assert.equal(reloaded.facts[0].embedding, undefined, 'legacy facts load without embeddings');
        await reloaded.query({ text: 'car' });
        assert.ok(embedder.calls.includes('automobile speed'), 'query() must lazily embed the legacy fact');
        assert.ok(Array.isArray(reloaded.facts[0].embedding));
    });
});

describe('CompositeMemoryProvider', () => {
    it('ranks vector scores across banks unchanged (score is the shared contract)', async () => {
        const { provider: p1 } = makeProvider({ options: { name: 'a', embedder: makeEmbedder() } });
        const { provider: p2 } = makeProvider({ options: { name: 'b' } });
        await p1.store({ content: 'automobile speed', category: 'general' });
        await p2.store({ content: 'recipe for pie', category: 'cooking' });
        const composite = new CompositeMemoryProvider({ providers: [p1, p2] });
        const results = /** @type {any[]} */ (await composite.query({ text: 'car' }));
        assert.equal(results[0].content, 'automobile speed');
    });

    it('a partial lexical hit never outranks a strong semantic match (same scale)', async () => {
        const { provider: vec } = makeProvider({ options: { name: 'a', embedder: makeEmbedder() } });
        const { provider: lex } = makeProvider({ options: { name: 'b' } });
        await vec.store({ content: 'automobile engine spec', category: 'general' });
        await lex.store({ content: 'modules everywhere', category: 'general' });
        const composite = new CompositeMemoryProvider({ providers: [vec, lex] });
        const results = /** @type {any[]} */ (await composite.query({ text: 'engine modules' }));
        assert.equal(results[0].content, 'automobile engine spec',
            'the 0.99 cosine match must outrank the 0.5 lexical overlap');
        assert.ok(results[0].score > 0.9);
        assert.ok(results[1].score < 1 && results[1].score > 0,
            'the lexical hit must carry a ratio score in (0,1), not a token count');
    });
});

// ─── Blind A/B report (BLIND_REPORT=1) ────────────────────────────────────
if (process.env.BLIND_REPORT) {
    /** @param {{provider: *, query: *}} arg0 */
    const run = async ({ provider, query }) => (await provider.query({ text: query })).map((/** @type {any} */ f) => ({
        content: f.content,
        score: typeof f.score === 'number' ? f.score : null,
    }));

    const { provider: bankA } = makeProvider({ options: { name: 'bank', embedder: makeEmbedder() } });
    const { provider: bankB } = makeProvider({ options: { name: 'bank' } });
    for (const fact of ['automobile engine spec', 'recipe for pie', 'driving speed record']) {
        await bankA.store({ content: fact, category: 'general' });
        await bankB.store({ content: fact, category: 'general' });
    }

    const report = await Promise.all(['car', 'engine', 'politics'].map(async (query) => ({
        scenario: `query "${query}"`,
        input: { query, facts: bankA.facts.map(f => f.content) },
        implA_merci_vector: { results: await run({ provider: bankA, query }) },
        implB_reference_lexical: { results: await run({ provider: bankB, query }) },
    })));

    const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scratchpad');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'blind-report-vector.json'), JSON.stringify(report, null, 2));
    console.log(`[blind-report] wrote scratchpad/blind-report-vector.json (${report.length} scenarios)`);
}

describe('session wiring keeps the embedder receiver', () => {
    it('withMemory binds client.embed so backfill can persist a vector', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-embed-bind-'));
        const filePath = join(dir, 'bank.json');
        writeFileSync(filePath, JSON.stringify({ version: 1, history: [], facts: [{
            id: 'fact_bind_1', content: 'the blue orbit staging runner', category: 'project', timestamp: 1,
        }] }));
        const client = /** @type {any} */ (new OaiClient({ options: { apiKey: 'test-key', baseURL: 'https://example.test/v1' } }));
        /** @type {any} */
        let receiver = null;
        client.embed = async function (/** @type {{input: any}} */ { input }) {
            receiver = this;
            return Array.isArray(input) ? input.map(() => [1, 2]) : [1, 2];
        };
        const provider = new LocalFileMemoryProvider({ options: { filePath, name: 'bind' } });
        const session = /** @type {any} */ (client.session('m')).withMemory({ provider, options: { preload: false } });
        await session._memoryComponent.engine.load({ query: 'blue orbit' });
        assert.equal(receiver, client, 'the embedder keeps the client as its receiver');
        const bank = JSON.parse(readFileSync(filePath, 'utf8'));
        assert.deepEqual(bank.facts[0].embedding, [1, 2], 'the backfilled vector is persisted');
    });
});
