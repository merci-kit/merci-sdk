// @ts-check

/**
 * Wave 9 / B3 — the memory bank keeps an audit trail.
 *
 * A bank recorded current state only: deleting a fact left an id and no old value, so
 * "what did the agent forget or rewrite" was unanswerable — the exact question a
 * long-term-memory audit has to answer. Every add, rewrite, forget and clear now
 * appends one bounded row with the value on both sides and the session that did it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalFileMemoryProvider } from '../lib/agentic/memory/index.mjs';
import { LIMITS } from '../lib/core/limit-config.mjs';

/** @param {string} dir */
const providerAt = (dir) => new LocalFileMemoryProvider({ options: { filePath: join(dir, 'memory.json') } });

test('B3/trail: add, rewrite and forget are each recorded with the value on both sides', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-b3-'));
    try {
        const provider = providerAt(dir);
        const row = /** @type {any} */ (await provider.store({ content: 'the release is on friday', opts: { sessionKey: 'conv-1' } }));
        assert.deepEqual(provider.history.map((r) => r.event), ['add']);
        assert.equal(provider.history[0].new, 'the release is on friday');
        assert.equal(provider.history[0].old, null);
        assert.equal(provider.history[0].actor, 'conv-1', 'the session that wrote it');

        await provider.store({ content: 'the release is on friday', opts: { sessionKey: 'conv-1' } });
        assert.deepEqual(provider.history.map((r) => r.event), ['add', 'update']);

        await provider.delete({ id: String(row.id), opts: { sessionKey: 'conv-1' } });
        const last = provider.history.at(-1);
        assert.equal(last?.event, 'delete');
        assert.equal(last?.old, 'the release is on friday', 'the forgotten value is recoverable');
        assert.equal(last?.new, null);
        assert.equal(last?.actor, 'conv-1');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('B3/persisted: the trail survives the file and a fresh provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-b3-'));
    try {
        const first = providerAt(dir);
        const row = /** @type {any} */ (await first.store({ content: 'region is eu-west-1', opts: { sessionKey: 'conv-2' } }));
        await first.delete({ id: String(row.id), opts: { sessionKey: 'conv-2' } });
        const raw = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
        assert.equal(raw.history.at(-1).event, 'delete', 'the file carries the trail');
        assert.equal(raw.history.at(-1).old, 'region is eu-west-1');

        const second = providerAt(dir);
        await second.load();
        assert.equal(second.history.at(-1)?.event, 'delete');
        assert.equal(second.history.at(-1)?.old, 'region is eu-west-1');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('B3/clear: clearing the bank records what it forgot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-b3-'));
    try {
        const provider = providerAt(dir);
        await provider.store({ content: 'fact one', opts: { sessionKey: 'conv-3' } });
        await provider.store({ content: 'fact two', opts: { sessionKey: 'conv-3' } });
        await provider.clear({ opts: { sessionKey: 'conv-3' } });
        const cleared = provider.history.filter((r) => r.event === 'clear').map((r) => r.old).sort();
        assert.deepEqual(cleared, ['fact one', 'fact two']);
        assert.equal(provider.history.at(-1)?.actor, 'conv-3', 'the clear names the session that did it');
        assert.equal(provider.facts.length, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('B3/bounded: the trail keeps the most recent rows only', async () => {
    const { MEMORY_MAX_HISTORY_ROWS } = await import('../lib/core/constants/memory.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'merci-b3-'));
    try {
        const provider = providerAt(dir);
        const total = MEMORY_MAX_HISTORY_ROWS + 5;
        for (let i = 0; i < total; i += 1) await provider.store({ content: `fact ${i}` });
        assert.equal(provider.history.length, MEMORY_MAX_HISTORY_ROWS, 'the in-memory trail is bounded');
        assert.equal(provider.history[0]?.new, 'fact 5', 'the oldest rows were dropped');
        assert.equal(provider.history.at(-1)?.new, `fact ${total - 1}`);
        const rows = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8')).history;
        assert.equal(rows.length, MEMORY_MAX_HISTORY_ROWS, 'and so is the file');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('B3/actor: an anonymous write records no actor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-b3-'));
    try {
        const provider = providerAt(dir);
        await provider.store({ content: 'no session here' });
        assert.equal(provider.history[0]?.actor, null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('B3/eviction: a fact dropped by the bank cap is recorded as forgotten', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-b3-'));
    try {
        const provider = providerAt(dir);
        await provider.load();
        provider.facts = Array.from({ length: LIMITS.memory_max_facts_per_bank }, (_, i) => ({
            id: `old-${i}`, content: `old fact ${i}`, category: 'fact', timestamp: i,
        }));
        await provider.store({ content: 'the newest fact' });
        const evicted = provider.history.filter((r) => r.event === 'evict');
        assert.equal(evicted.length, 1, 'one eviction, one row');
        assert.equal(evicted[0].old, 'old fact 0', 'the oldest fact is the one that went');
        assert.equal(provider.facts.length, LIMITS.memory_max_facts_per_bank);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('B3/large-clear: a clear beyond the trail bound leaves a summary row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merci-b3-'));
    try {
        const { MEMORY_MAX_HISTORY_ROWS } = await import('../lib/core/constants/memory.mjs');
        const provider = providerAt(dir);
        const total = MEMORY_MAX_HISTORY_ROWS + 5;
        await provider.load();
        provider.facts = Array.from({ length: total }, (_, i) => ({ id: `f-${i}`, content: `fact ${i}`, category: 'fact', timestamp: i }));
        await provider.clear({ opts: { sessionKey: 'conv-4' } });
        const summary = provider.history.find((r) => r.event === 'clear' && r.id === '*');
        assert.ok(summary, 'the clear that outran the bound still says how much it forgot');
        assert.equal(summary?.new, `${total} facts`);
        assert.equal(summary?.actor, 'conv-4');
        assert.equal(provider.history.length, MEMORY_MAX_HISTORY_ROWS);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
