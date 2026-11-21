// @ts-check
/**
 * The SQLite memory bank persists the same facts/checkpoint/audit shape as the
 * file bank, in one transaction. `node:sqlite` is loaded lazily, so this file
 * is the only place its ExperimentalWarning can appear.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteMemoryProvider } from '../lib/agentic/memory/providers.mjs';

/** @returns {Promise<{dir: string, file: string, done: () => Promise<void>}>} */
async function tempBank() {
    const dir = await mkdtemp(join(tmpdir(), 'merci-sqlite-'));
    return {
        dir,
        file: join(dir, 'memory.sqlite'),
        done: () => rm(dir, { recursive: true, force: true }),
    };
}

/** @param {{file: string, name?: string}} arg0 */
function provider({ file, name = 'workspace' }) {
    return new SqliteMemoryProvider({ options: { filePath: file, name } });
}

test('stores, queries and reloads facts across a close', async () => {
    const bank = await tempBank();
    try {
        const first = provider({ file: bank.file });
        await first.load();
        await first.store({ content: 'the deploy uses blue-green', category: 'config' });
        assert.equal(first.facts.length, 1);
        assert.equal(first.lastSyncedTurnIndex, 0);
        first.lastSyncedTurnIndex = 7;
        await first.save();
        first.close();

        const second = provider({ file: bank.file });
        await second.load();
        assert.equal(second.facts.length, 1);
        assert.equal(second.lastSyncedTurnIndex, 7);
        const hits = await second.query({ text: 'deploy blue-green' });
        assert.equal(hits.length, 1);
        assert.match(hits[0].content, /blue-green/);
        second.close();
    } finally {
        await bank.done();
    }
});

test('delete and clear survive a reload', async () => {
    const bank = await tempBank();
    try {
        const first = provider({ file: bank.file });
        await first.load();
        const kept = await first.store({ content: 'keep me' });
        const gone = await first.store({ content: 'delete me' });
        assert.ok(kept && gone);
        assert.equal(await first.delete({ id: gone.id }), true);
        await first.save();
        first.close();

        const second = provider({ file: bank.file });
        await second.load();
        assert.deepEqual(second.facts.map((fact) => fact.content), ['keep me']);
        await second.clear();
        await second.save();
        second.close();

        const third = provider({ file: bank.file });
        await third.load();
        assert.deepEqual(third.facts, []);
        third.close();
    } finally {
        await bank.done();
    }
});

test('a version mismatch drops the row instead of throwing', async () => {
    const bank = await tempBank();
    try {
        const first = provider({ file: bank.file });
        await first.load();
        await first.store({ content: 'old fact' });
        first.close();

        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(bank.file);
        db.prepare('UPDATE memory_bank SET version = ?').run(999);
        db.close();

        const second = provider({ file: bank.file });
        await second.load();
        assert.deepEqual(second.facts, [], 'a mismatched bank starts empty');
        second.close();

        const reopened = new DatabaseSync(bank.file);
        const row = reopened.prepare('SELECT COUNT(*) AS n FROM memory_bank').get();
        reopened.close();
        assert.equal(/** @type {any} */ (row).n, 0, 'the bad row is gone');
    } finally {
        await bank.done();
    }
});

test('two writers on one file keep both facts', async () => {
    const bank = await tempBank();
    try {
        const a = provider({ file: bank.file, name: 'a' });
        const b = provider({ file: bank.file, name: 'a' });
        await Promise.all([a.load(), b.load()]);
        await Promise.all([
            a.store({ content: 'fact from a' }),
            b.store({ content: 'fact from b' }),
        ]);
        a.close();
        b.close();

        const reopened = provider({ file: bank.file, name: 'a' });
        await reopened.load();
        const contents = reopened.facts.map((fact) => fact.content).sort();
        assert.deepEqual(contents, ['fact from a', 'fact from b']);
        reopened.close();
    } finally {
        await bank.done();
    }
});
