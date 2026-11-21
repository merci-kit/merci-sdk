// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readStoredJson, quarantineFile, writeJsonAtomic, writeJsonAtomicSync } from '../lib/support/fs-store.mjs';

function scratch() {
    return mkdtempSync(join(tmpdir(), 'merci-fs-store-'));
}

describe('fs-store', () => {
    it('writeJsonAtomic writes 2-space JSON and leaves no tmp file', async () => {
        const dir = scratch();
        try {
            const file = join(dir, 'bank.json');
            await writeJsonAtomic({ filePath: file, data: { version: 1, facts: ['a'] } });
            assert.equal(readFileSync(file, 'utf8'), JSON.stringify({ version: 1, facts: ['a'] }, null, 2));
            assert.ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no tmp residue');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('writeJsonAtomicSync writes the same bytes and leaves no tmp file', () => {
        const dir = scratch();
        try {
            const file = join(dir, 'task.json');
            writeJsonAtomicSync({ filePath: file, data: { version: 1, task: { taskId: 'a' } } });
            assert.equal(readFileSync(file, 'utf8'), JSON.stringify({ version: 1, task: { taskId: 'a' } }, null, 2));
            assert.ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no tmp residue');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('readStoredJson reports missing, ok and corrupt', async () => {
        const dir = scratch();
        try {
            const file = join(dir, 'bank.json');
            assert.deepEqual(await readStoredJson({ filePath: file }), { status: 'missing' });

            await writeJsonAtomic({ filePath: file, data: { version: 1, facts: [] } });
            const ok = await readStoredJson({ filePath: file });
            assert.equal(ok.status, 'ok');
            assert.deepEqual(ok.value, { version: 1, facts: [] });

            writeFileSync(file, '{not json at all', 'utf8');
            const bad = await readStoredJson({ filePath: file });
            assert.equal(bad.status, 'corrupt');
            assert.equal(bad.kind, 'parse');
            assert.ok(bad.reason, 'a parse failure carries a reason');
            // The strict guard's reason is generic: it never quotes the file.
            assert.equal(bad.reason, 'Failed to parse JSON structure');
            assert.equal(bad.reason.includes('not json at all'), false);

            // Strict, not healing: guardedParse repairs this shape; the store
            // must reject it instead of silently accepting a corrupt bank.
            writeFileSync(file, '{facts:[]}', 'utf8');
            const nearValid = await readStoredJson({ filePath: file });
            assert.equal(nearValid.status, 'corrupt');
            assert.equal(nearValid.kind, 'parse');
            assert.equal(nearValid.reason, 'Failed to parse JSON structure');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('readStoredJson flags a version mismatch but accepts a missing version', async () => {
        const dir = scratch();
        try {
            const file = join(dir, 'bank.json');
            await writeJsonAtomic({ filePath: file, data: { version: 2 } });
            const mismatch = await readStoredJson({ filePath: file, version: 1 });
            assert.equal(mismatch.status, 'corrupt');
            assert.equal(mismatch.kind, 'version');
            assert.equal(mismatch.reason, '2');

            await writeJsonAtomic({ filePath: file, data: { facts: [] } });
            assert.equal((await readStoredJson({ filePath: file, version: 1 })).status, 'ok');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('quarantineFile renames to a .corrupt- sibling and reports success', async () => {
        const dir = scratch();
        try {
            const file = join(dir, 'bank.json');
            writeFileSync(file, '{corrupt bytes', 'utf8');
            /** @type {Array<{path: string, ok: boolean}>} */
            const seen = [];
            const path = await quarantineFile({ filePath: file, reason: 'is corrupt', onQuarantine: (r) => seen.push(/** @type {any} */ (r)) });
            assert.match(path, /bank\.json\.corrupt-/);
            assert.equal(readFileSync(path, 'utf8'), '{corrupt bytes');
            assert.deepEqual(seen, [{ path, ok: true }]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('quarantineFile on a missing file reports failure and never throws', async () => {
        const dir = scratch();
        try {
            /** @type {any[]} */
            const seen = [];
            const path = await quarantineFile({ filePath: join(dir, 'gone.json'), reason: 'is corrupt', onQuarantine: (r) => seen.push(r) });
            assert.equal(seen.length, 1);
            assert.equal(seen[0].ok, false);
            assert.ok(seen[0].error, 'the rename error is surfaced');
            assert.match(path, /gone\.json\.corrupt-/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('fs-store durability', () => {
    it('fsyncs the tmp file before the rename', async () => {
        const { promises: fsp } = await import('node:fs');
        const { mock } = await import('node:test');
        const dir = scratch();
        const realOpen = fsp.open.bind(fsp);
        let syncs = 0;
        mock.method(fsp, 'open', async (/** @type {any} */ ...args) => {
            const handle = await /** @type {any} */ (realOpen)(...args);
            const realSync = handle.sync.bind(handle);
            handle.sync = async () => { syncs += 1; return realSync(); };
            return handle;
        });
        try {
            const file = join(dir, 'durable.json');
            await writeJsonAtomic({ filePath: file, data: { ok: true } });
            assert.equal(syncs, 1, 'the data was flushed before the rename');
            assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ok: true });
        } finally {
            mock.restoreAll();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
