// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryManager } from '../lib/agentic/memory/manager.mjs';
import { LocalFileMemoryProvider, CompositeMemoryProvider } from '../lib/agentic/memory/providers.mjs';
import { TodoComponent } from '../lib/agentic/todos/component.mjs';

/** @param {{prefix: string}} arg0 */
function tmpDir({ prefix }) {
    return mkdtempSync(join(tmpdir(), prefix));
}

/** @param {{name: string, facts: Array<Record<string, any>>}} arg0 */
function stubProvider({ name, facts }) {
    return {
        name,
        description: name,
        async load() {},
        async save() {},
        async query() { return facts; },
        async store() { return null; },
        async delete() { return false; },
        async clear() {},
        getBankDescriptions() { return ''; },
    };
}

/** @param {{name: string}} arg0 */
function brokenProvider({ name }) {
    const boom = () => { throw new Error(`${name} is down`); };
    return {
        name,
        description: name,
        async load() { boom(); },
        async save() { boom(); },
        async query() { boom(); },
        async store() { boom(); },
        async delete() { boom(); },
        async clear() { boom(); },
        getBankDescriptions() { return ''; },
    };
}

// ─── F3: composite provider per-bank isolation ───────────────────────────────

test('F3: composite load/query resolve with the healthy bank when another bank throws', async () => {
    const dir = tmpDir({ prefix: 'merci-f3-' });
    try {
        const good = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'good.json'), name: 'good' } });
        await good.store({ content: 'alpha beta' });
        /** @type {any} */ const composite = new CompositeMemoryProvider({ providers: [good, brokenProvider({ name: 'broken' })] });
        await assert.doesNotReject(() => composite.load(), 'one failing bank must not reject the whole load');
        const results = /** @type {any[]} */ (await composite.query({ text: 'alpha' }));
        assert.equal(results.length, 1, 'the healthy bank facts must survive a sibling query throw');
        assert.equal(results[0].content, 'alpha beta');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('F3: composite store reaches the healthy bank when an earlier target throws', async () => {
    const dir = tmpDir({ prefix: 'merci-f3b-' });
    try {
        const good = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'good.json'), name: 'good' } });
        /** @type {any} */ const composite = new CompositeMemoryProvider({ providers: [brokenProvider({ name: 'broken' }), good] });
        const fact = /** @type {any} */ (await composite.store({ content: 'gamma fact', category: 'general', targetBanks: ['broken', 'good'] }));
        assert.ok(fact, 'store must resolve when at least one target bank succeeded');
        assert.deepEqual(good.facts.map(f => f.content), ['gamma fact'], 'the healthy bank must receive the fact');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('F3: composite save resolves on a partial failure and rejects when every bank fails', async () => {
    const dir = tmpDir({ prefix: 'merci-f3c-' });
    try {
        const good = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'good.json'), name: 'good' } });
        /** @type {any} */ const partial = new CompositeMemoryProvider({ providers: [good, brokenProvider({ name: 'broken' })] });
        await assert.doesNotReject(() => partial.save(), 'a partial save failure must be a warning, not a rejection');
        /** @type {any} */ const allBroken = new CompositeMemoryProvider({ providers: [brokenProvider({ name: 'a' }), brokenProvider({ name: 'b' })] });
        await assert.rejects(() => allBroken.save(), /is down/, 'a total save failure must still throw');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ─── F11: hybrid lexical + vector fusion ─────────────────────────────────────

test('F11: an exact lexical match outranks a near-zero cosine hit', async () => {
    const dir = tmpDir({ prefix: 'merci-f11-' });
    try {
        const vectors = /** @type {Record<string, number[]>} */ ({
            'alpha beta': [0.01, 0.99995],
            'gamma delta': [0.05, 0.99875],
            alpha: [1, 0],
        });
        const provider = new LocalFileMemoryProvider({ options: {
            filePath: join(dir, 'm.json'),
            embedder: async (/** @type {string} */ text) => vectors[String(text)] || [0, 0],
        } });
        await provider.store({ content: 'alpha beta' });
        await provider.store({ content: 'gamma delta' });
        const results = /** @type {any[]} */ (await provider.query({ text: 'alpha' }));
        assert.equal(results[0].content, 'alpha beta', 'the exact token match must rank first despite the near-zero cosine');
        assert.ok(results[0].score > results[1].score, 'fusion must add the lexical overlap to the cosine score');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('F11: composite dedupe prefers the higher-scoring duplicate', async () => {
    /** @type {any} */ const composite = new CompositeMemoryProvider({ providers: [
        stubProvider({ name: 'a', facts: [{ id: 'low', content: 'dup content', timestamp: 1, score: 0.2 }] }),
        stubProvider({ name: 'b', facts: [{ id: 'high', content: '  DUP Content  ', timestamp: 2, score: 0.9 }] }),
    ] });
    const results = /** @type {any[]} */ (await composite.query({ text: 'anything' }));
    assert.equal(results.length, 1, 'duplicates must still collapse');
    assert.equal(results[0].id, 'high', 'the higher-scoring duplicate must win');
});

// ─── F10: size bounds ────────────────────────────────────────────────────────

test('F10: a 1MB fact is stored capped with a visible truncation marker', async () => {
    const dir = tmpDir({ prefix: 'merci-f10-' });
    try {
        const provider = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'm.json') } });
        const fact = /** @type {any} */ (await provider.store({ content: 'x'.repeat(1_000_000) }));
        assert.ok(fact, 'the capped fact must still store');
        assert.ok(fact.content.length < 5000, `stored fact must be capped, got ${fact.content.length} chars`);
        assert.ok(fact.content.includes('truncated'), 'the cap must be visible in the stored content');
        const recalled = /** @type {any[]} */ (await provider.query({ text: 'xxxx' }));
        assert.ok(recalled[0].content.length < 5000, 'recall must never inject the whole 1MB fact');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('F10: the distill prompt is bounded with a visible marker', async () => {
    const dir = tmpDir({ prefix: 'merci-f10b-' });
    try {
        const provider = new LocalFileMemoryProvider({ options: { filePath: join(dir, 'm.json') } });
        for (let i = 0; i < 6; i++) await provider.store({ content: `fact ${i} ${'y'.repeat(4000)}` });
        const manager = new MemoryManager({ provider, options: { syncInterval: 1 } });
        let prompt = '';
        const fakeClient = {
            session() {
                return {
                    withSystemMessage() { return this; },
                    withParameters() { return this; },
                    /** @param {{initialInput: any}} arg0 */
                    async run({ initialInput: input }) {
                        prompt = input;
                        return '{"newFacts":[],"obsoleteFactIds":[]}';
                    },
                };
            },
        };
        await manager.distill({ messages: [{ role: 'user', content: `huge transcript ${'z'.repeat(200_000)}` }], client: fakeClient, modelToUse: 'm', options: {} });
        assert.ok(prompt.length > 0, 'the fake client must have captured the prompt');
        assert.ok(prompt.length < 45_000, `distill prompt must be bounded, got ${prompt.length} chars`);
        assert.ok(prompt.includes('truncated'), 'the prompt cap must be visible to the distiller');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ─── F12: todos hygiene ──────────────────────────────────────────────────────

test('F12: the preload block renders at most the most recent 20 tasks plus an omission marker', async () => {
    /** @type {Map<string|number, any>} */
    const store = new Map();
    for (let i = 1; i <= 50; i++) {
        store.set(i, { id: i, title: `task ${i}`, status: 'pending', createdAt: 1000 + i });
    }
    const c = new TodoComponent({ store });
    const block = /** @type {string} */ (await c.load());
    const rows = block.split('\n').filter(l => l.includes('id:'));
    assert.ok(rows.length <= 20, `the preload block must cap rendered rows, got ${rows.length}`);
    assert.ok(block.includes('omitted'), 'the cap must be visible as an omission marker');
    assert.ok(block.includes('task 50'), 'the most recent tasks must be the ones rendered');
    assert.ok(!block.includes('task 1 '), 'the oldest tasks must be omitted');
});

test('F12: prune removes old completed/failed tasks and keeps pending ones', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const old = Date.now() - 8 * DAY;
    /** @type {Map<string|number, any>} */
    const store = new Map([
        [1, { id: 1, title: 'old completed', status: 'completed', createdAt: old }],
        [2, { id: 2, title: 'old failed', status: 'failed', createdAt: old }],
        [3, { id: 3, title: 'old pending', status: 'pending', createdAt: old }],
        [4, { id: 4, title: 'recent completed', status: 'completed', createdAt: Date.now() }],
    ]);
    const c = new TodoComponent({ store });
    const r = /** @type {any} */ (await c.save({ args: { action: 'prune' } }));
    assert.equal(r.success, true);
    assert.equal(r.pruned, 2, 'only the old finished tasks must be pruned');
    assert.deepEqual([...store.keys()], [3, 4], 'pending and recent finished tasks must survive');
});
