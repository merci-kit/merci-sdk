// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MerciClient as OaiClient } from '../lib/backends/oai.mjs';
import { MerciClient as GaiClient } from '../lib/backends/gai.mjs';
import { MerciClient as JaiClient } from '../lib/backends/jai.mjs';
import { LocalFileMemoryProvider } from '../lib/agentic/memory/providers.mjs';

function oai() {
    return new OaiClient({ options: { apiKey: 'test-key', baseURL: 'https://example.test/v1', embedMaxRetries: 0 } });
}

describe('OAI embed batching', () => {
    it('returns one vector per input, ordered by index', async () => {
        const client = oai();
        (/** @type {any} */ (client)).transport.embeddings = {
            /** @param {{input: *}} arg0 */
            create: async (/** @type {any} */ { input }) => {
                assert.deepEqual(input, ['a', 'b']);
                return { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] };
            },
        };
        assert.deepEqual(await client.embed({ input: ['a', 'b'] }), [[1, 0], [0, 1]]);
    });

    it('null-fills a batch item whose embedding is missing (aligned, not dropped)', async () => {
        const client = oai();
        (/** @type {any} */ (client)).transport.embeddings = {
            create: async () => ({ data: [{ index: 0, embedding: [1, 0] }, { index: 1 }] }),
        };
        assert.deepEqual(await client.embed({ input: ['a', 'b'] }), [[1, 0], null]);
    });

    it('leaves the single-string path unchanged', async () => {
        const client = oai();
        (/** @type {any} */ (client)).transport.embeddings = {
            create: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }),
        };
        assert.deepEqual(await client.embed({ input: 'hello' }), [1, 0]);
    });
});

describe('GAI embed batching', () => {
    it('returns one vector per input', async () => {
        const client = new GaiClient({ options: { apiKey: 'test-key' } });
        (/** @type {any} */ (client)).transport.models = {
            /** @param {{contents: *}} arg0 */
            embedContent: async (/** @type {any} */ { contents }) => {
                assert.deepEqual(contents, [{ parts: [{ text: 'a' }] }, { parts: [{ text: 'b' }] }]);
                return { embeddings: [{ values: [1, 0] }, { values: [0, 1] }] };
            },
        };
        assert.deepEqual(await client.embed({ input: ['a', 'b'] }), [[1, 0], [0, 1]]);
    });

    it('null-fills a batch item whose embedding is missing (aligned, not dropped)', async () => {
        const client = new GaiClient({ options: { apiKey: 'test-key' } });
        (/** @type {any} */ (client)).transport.models = {
            embedContent: async () => ({ embeddings: [{ values: [1, 0] }, {}] }),
        };
        assert.deepEqual(await client.embed({ input: ['a', 'b'] }), [[1, 0], null]);
    });

    it('leaves the single-string path unchanged', async () => {
        const client = new GaiClient({ options: { apiKey: 'test-key' } });
        (/** @type {any} */ (client)).transport.models = { embedContent: async () => ({ embeddings: [{ values: [1, 0] }] }) };
        assert.deepEqual(await client.embed({ input: 'hello' }), [1, 0]);
    });

    it('falls back to per-item calls on Vertex (multi-content is rejected there)', async () => {
        const client = new GaiClient({ options: { apiKey: 'test-key', genaiOptions: { vertexai: true, project: 'p', location: 'global' } } });
        /** @type {any[]} */
        const seen = [];
        (/** @type {any} */ (client)).transport.models = {
            /** @param {{contents: *}} arg0 */
            embedContent: async (/** @type {any} */ { contents }) => {
                seen.push(contents);
                assert.equal(Array.isArray(contents), false, 'Vertex must receive one content per call');
                return { embeddings: [{ values: [1, 0] }] };
            },
        };
        assert.deepEqual(await client.embed({ input: ['a', 'b'] }), [[1, 0], [1, 0]]);
        assert.deepEqual(seen, ['a', 'b']);
    });
});

describe('memory backfill batching', () => {
    it('sends one batched request for a slice of legacy facts', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-embed-'));
        const provider = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'memory.json'), name: 'test' } });
        await provider.store({ content: 'first fact', category: 'general' });
        await provider.store({ content: 'second fact', category: 'general' });

        /** @type {any[]} */
        const batched = [];
        const embedder = async (/** @type {any} */ input) => {
            batched.push(input);
            if (!Array.isArray(input)) throw new Error('expected a batched call');
            return input.map(() => [1, 0]);
        };
        provider.embedder = embedder;
        provider.facts.forEach((f) => { f.embedding = undefined; });

        await provider.query({ text: 'first' });
        const batchCalls = batched.filter(Array.isArray);
        assert.equal(batchCalls.length, 1, 'backfill must issue one batched call, not N singles');
        assert.deepEqual(batchCalls[0], ['first fact', 'second fact']);
        assert.ok(provider.facts.every((f) => Array.isArray(f.embedding)));
    });

    it('falls back to per-item calls for a string-only embedder', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merci-embed-'));
        const provider = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'memory.json'), name: 'test' } });
        await provider.store({ content: 'first fact', category: 'general' });
        await provider.store({ content: 'second fact', category: 'general' });

        /** @type {any[]} */
        const calls = [];
        provider.embedder = async (/** @type {any} */ input) => {
            calls.push(input);
            return [1, 0];
        };
        provider.facts.forEach((f) => { f.embedding = undefined; });

        await provider.query({ text: 'first' });
        assert.deepEqual(calls, [['first fact', 'second fact'], 'first fact', 'second fact', 'first'],
            'a wrong batch shape must fall back to per-item calls (the last call embeds the query)');
        assert.ok(provider.facts.every((f) => Array.isArray(f.embedding)));
    });
});

describe('JAI embed', () => {
    it('posts texts + configured dimensions to /indexing/embeddings/qwen/compute and maps embeddings', async () => {
        const client = new JaiClient({ options: { token: 'test-token' } });
        /** @type {any} */
        let captured = null;
        (/** @type {any} */ (client)).httpClient._fetchWithRetry = async (/** @type {any} */ { path, options }) => {
            captured = { path, body: JSON.parse(options.body) };
            return new Response(JSON.stringify({ embeddings: [{ values: [1, 0] }, { values: [0, 1] }] }));
        };
        const saved = process.env.DEFAULT_JAI_EMBEDDING_DIMENSIONS;
        process.env.DEFAULT_JAI_EMBEDDING_DIMENSIONS = '768';
        try {
            assert.deepEqual(await client.embed({ input: ['a', 'b'] }), [[1, 0], [0, 1]]);
        } finally {
            if (saved === undefined) delete process.env.DEFAULT_JAI_EMBEDDING_DIMENSIONS;
            else process.env.DEFAULT_JAI_EMBEDDING_DIMENSIONS = saved;
        }
        assert.equal(captured.path, '/indexing/embeddings/qwen/compute');
        assert.deepEqual(captured.body, { input: ['a', 'b'], dimensions: 768, task: 'compute' });
    });

    it('falls back to the default 1024 dimensions and returns a single vector for a string', async () => {
        const client = new JaiClient({ options: { token: 'test-token' } });
        /** @type {any} */
        let captured = null;
        (/** @type {any} */ (client)).httpClient._fetchWithRetry = async (/** @type {any} */ { path, options }) => {
            captured = { path, body: JSON.parse(options.body) };
            return new Response(JSON.stringify({ embeddings: [{ values: [0.5, 0.5] }] }));
        };
        const saved = process.env.DEFAULT_JAI_EMBEDDING_DIMENSIONS;
        delete process.env.DEFAULT_JAI_EMBEDDING_DIMENSIONS;
        try {
            assert.deepEqual(await client.embed({ input: 'hello' }), [0.5, 0.5]);
        } finally {
            if (saved !== undefined) process.env.DEFAULT_JAI_EMBEDDING_DIMENSIONS = saved;
        }
        assert.deepEqual(captured.body, { input: ['hello'], dimensions: 1024, task: 'compute' });
    });
});

describe('embedding model is env-configurable', () => {
    /** @param {{perKey: string, genericKey: string, makeClient: () => any, install: (client: any, models: string[]) => void}} arg0 */
    async function assertModelResolution({ perKey, genericKey, makeClient, install }) {
        const client = makeClient();
        /** @type {string[]} */
        const models = [];
        install(client, models);
        const savedPer = process.env[perKey];
        const savedGeneric = process.env[genericKey];
        try {
            process.env[perKey] = 'custom-embed-model';
            process.env[genericKey] = 'generic-embed-model';
            await client.embed({ input: 'x' });
            process.env[perKey] = '';
            await client.embed({ input: 'x' });
        } finally {
            if (savedPer === undefined) delete process.env[perKey]; else process.env[perKey] = savedPer;
            if (savedGeneric === undefined) delete process.env[genericKey]; else process.env[genericKey] = savedGeneric;
        }
        assert.deepEqual(models, ['custom-embed-model', 'generic-embed-model']);
    }

    it('GAI: per-backend key wins over DEFAULT_GEMINI_EMBEDDING_MODEL', async () => {
        await assertModelResolution({
            perKey: 'DEFAULT_GOOGLE_GENAI_EMBEDDING_MODEL',
            genericKey: 'DEFAULT_GEMINI_EMBEDDING_MODEL',
            makeClient: () => new GaiClient({ options: { apiKey: 'test-key' } }),
            install: (client, models) => {
                (/** @type {any} */ (client)).transport.models = {
                    embedContent: async (/** @type {any} */ { model }) => { models.push(model); return { embeddings: [{ values: [1, 0] }] }; },
                };
            },
        });
    });

    it('GAI: no model configured disables embeddings (returns null)', async () => {
        const client = new GaiClient({ options: { apiKey: 'test-key' } });
        (/** @type {any} */ (client)).transport.models = { embedContent: async () => { throw new Error('must not be called'); } };
        const savedPer = process.env.DEFAULT_GOOGLE_GENAI_EMBEDDING_MODEL;
        const savedGeneric = process.env.DEFAULT_GEMINI_EMBEDDING_MODEL;
        try {
            process.env.DEFAULT_GOOGLE_GENAI_EMBEDDING_MODEL = '';
            process.env.DEFAULT_GEMINI_EMBEDDING_MODEL = '';
            assert.equal(await client.embed({ input: 'x' }), null);
        } finally {
            if (savedPer === undefined) delete process.env.DEFAULT_GOOGLE_GENAI_EMBEDDING_MODEL; else process.env.DEFAULT_GOOGLE_GENAI_EMBEDDING_MODEL = savedPer;
            if (savedGeneric === undefined) delete process.env.DEFAULT_GEMINI_EMBEDDING_MODEL; else process.env.DEFAULT_GEMINI_EMBEDDING_MODEL = savedGeneric;
        }
    });

    it('OAI: per-backend key wins over DEFAULT_EMBEDDING_MODEL', async () => {
        await assertModelResolution({
            perKey: 'DEFAULT_OPENAI_EMBEDDING_MODEL',
            genericKey: 'DEFAULT_EMBEDDING_MODEL',
            makeClient: () => oai(),
            install: (client, models) => {
                (/** @type {any} */ (client)).transport.embeddings = {
                    create: async (/** @type {any} */ { model }) => { models.push(model); return { data: [{ index: 0, embedding: [1, 0] }] }; },
                };
            },
        });
    });
});
