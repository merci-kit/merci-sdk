// @ts-check

/**
 * @file Stage 3 contract tests for the two claim stores.
 * @version 0.12.0
 *
 * @description
 * Pins the in-process map contract and the file store's O_EXCL lock, same-owner
 * idempotence, pid liveness, the strict stale rule, the hard-link reclaim
 * election (one winner, pin cleanup, fail-closed `link`), owner+host release,
 * and the fail-closed read path. The on-disk path
 * is derived with `workspaceKeyFor` from the workspace slice, so the documented
 * "one identifier, one key across the SDK" contract is pinned here too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

import { createFileClaimStore, createMemoryClaimStore } from '../lib/agentic/scheduler/index.mjs';
import { activateClaimOwner, deactivateClaimOwner } from '../lib/agentic/scheduler/claims.mjs';
import { workspaceKeyFor } from '../lib/agentic/workspace/index.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';

/**
 * @param {{fn: (arg0: {dir: string}) => Promise<void>}} arg0 -
 * @returns {Promise<void>}
 */
async function withTempDir({ fn }) {
    const dir = await fs.mkdtemp(join(tmpdir(), 'merci-claims-'));
    try {
        await fn({ dir });
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

/**
 * The documented claim-file path: the workspace key plus `.json`.
 * @param {{dir: string, workItemId: string}} arg0 -
 * @returns {string}
 */
function claimFile({ dir, workItemId }) {
    return join(dir, `${workspaceKeyFor({ workItemId })}.json`);
}

/**
 * @param {{workItemId: string, owner?: string, pid?: number, host?: string, claimedAt?: number}} arg0 -
 * @returns {{workItemId: string, owner: string, pid: number, host: string, claimedAt: number}}
 */
function claimRecord({ workItemId, owner = 'owner-a', pid = process.pid, host = 'this-host', claimedAt = 0 }) {
    return { workItemId, owner, pid, host, claimedAt };
}

/**
 * @param {{file: string, record: Record<string, unknown>}} arg0 -
 * @returns {Promise<void>}
 */
async function seedClaim({ file, record }) {
    await fs.writeFile(file, JSON.stringify(record));
}

/**
 * @param {{file: string}} arg0 -
 * @returns {Promise<boolean>}
 */
async function fileExists({ file }) {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

/**
 * @param {{file: string}} arg0 -
 * @returns {Promise<Record<string, unknown>>}
 */
async function readClaim({ file }) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

/**
 * @param {number} pid -
 * @returns {boolean}
 */
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return /** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH';
    }
}

/**
 * Spawn a child that exits at once and return its pid.
 * @returns {Promise<number>}
 */
function spawnShortLivedChild() {
    return new Promise((resolvePid, rejectPid) => {
        const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
        child.once('error', rejectPid);
        child.once('exit', () => {
            if (typeof child.pid === 'number') resolvePid(child.pid);
            else rejectPid(new Error('the child had no pid'));
        });
    });
}

/**
 * @param {{run: () => unknown, option: string}} arg0 -
 * @returns {Promise<void>}
 */
async function rejectsConfiguration({ run, option }) {
    await assert.rejects(async () => { await run(); }, (error) => {
        assert.ok(error instanceof ConfigurationError, `expected ConfigurationError, got ${String(error)}`);
        assert.equal(error.option, option);
        return true;
    });
}

/**
 * @param {{run: () => unknown, option: string}} arg0 -
 * @returns {void}
 */
function throwsConfiguration({ run, option }) {
    assert.throws(run, (error) => {
        assert.ok(error instanceof ConfigurationError, `expected ConfigurationError, got ${String(error)}`);
        assert.equal(error.option, option);
        return true;
    });
}

// ---------------------------------------------------------------------------
// Memory claim store
// ---------------------------------------------------------------------------

test('memory: the first owner wins, a second loses, and the same owner re-acquires', async () => {
    const store = createMemoryClaimStore();

    assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'host:1:a', now: 1_000 }), true);
    assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'host:1:b' }), false);
    assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'host:1:a', now: 9_999 }), true);
});

test('memory: release needs the exact owner, and a missing item is false', async () => {
    const store = createMemoryClaimStore();
    await store.acquire({ workItemId: 'MER-1', owner: 'host:1:a' });

    assert.equal(await store.release({ workItemId: 'MER-1', owner: 'host:1:b' }), false);
    assert.equal(await store.isClaimed({ workItemId: 'MER-1' }), true);
    assert.equal(await store.release({ workItemId: 'MER-1', owner: 'host:1:a' }), true);
    assert.equal(await store.isClaimed({ workItemId: 'MER-1' }), false);
    assert.equal(await store.release({ workItemId: 'MER-1', owner: 'host:1:a' }), false);
});

test('memory: list is the key set, and two stores do not share state', async () => {
    const first = createMemoryClaimStore();
    const second = createMemoryClaimStore();
    await first.acquire({ workItemId: 'MER-1', owner: 'a' });
    await first.acquire({ workItemId: 'MER-2', owner: 'a' });

    assert.deepEqual(await first.list(), ['MER-1', 'MER-2']);
    assert.deepEqual(await second.list(), []);
    assert.equal(await second.acquire({ workItemId: 'MER-1', owner: 'b' }), true);
    assert.equal(await second.isClaimed({ workItemId: 'MER-1' }), true);
});

// ---------------------------------------------------------------------------
// File claim store: the happy path
// ---------------------------------------------------------------------------

test('file: the first acquire wins and a second owner loses', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const store = createFileClaimStore({ dir, hostId: 'this-host' });

        assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'host:1:a' }), true);
        assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'host:1:b' }), false);
        assert.equal((await readClaim({ file: claimFile({ dir, workItemId: 'MER-1' }) })).owner, 'host:1:a');
    } });
});

test('file: the claim file has the documented shape at the workspace key path', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const store = createFileClaimStore({ dir, hostId: 'this-host', now: () => 4_321 });
        assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'host:1:a' }), true);

        const file = claimFile({ dir, workItemId: 'MER-1' });
        assert.equal(await fileExists({ file }), true);
        assert.deepEqual(await readClaim({ file }), {
            workItemId: 'MER-1',
            owner: 'host:1:a',
            pid: process.pid,
            host: 'this-host',
            claimedAt: 4_321
        });
    } });
});

test('file: a same-owner re-acquire is the heartbeat and refreshes claimedAt', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const store = createFileClaimStore({ dir, hostId: 'this-host' });
        const file = claimFile({ dir, workItemId: 'MER-1' });

        await store.acquire({ workItemId: 'MER-1', owner: 'host:1:a', now: 100 });
        assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'host:1:a', now: 900 }), true);
        // Without the refresh a claim held across a park ages past `staleMs`
        // and a foreign host displaces a live owner (F2-7).
        assert.deepEqual(await readClaim({ file }), {
            workItemId: 'MER-1',
            owner: 'host:1:a',
            pid: process.pid,
            host: 'this-host',
            claimedAt: 900
        });
    } });
});

test('file: release by a non-owner is false and leaves the file byte-identical', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const store = createFileClaimStore({ dir, hostId: 'this-host' });
        const file = claimFile({ dir, workItemId: 'MER-1' });
        await store.acquire({ workItemId: 'MER-1', owner: 'host:1:a' });
        const before = await fs.readFile(file);

        assert.equal(await store.release({ workItemId: 'MER-1', owner: 'host:1:b' }), false);
        assert.deepEqual(await fs.readFile(file), before);
        assert.equal(await store.isClaimed({ workItemId: 'MER-1' }), true);
    } });
});

test('file: release from a different host is false, and owner+host removes the file', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const store = createFileClaimStore({ dir, hostId: 'this-host' });
        const otherHost = createFileClaimStore({ dir, hostId: 'other-host' });
        const file = claimFile({ dir, workItemId: 'MER-1' });
        await store.acquire({ workItemId: 'MER-1', owner: 'host:1:a' });

        assert.equal(await otherHost.release({ workItemId: 'MER-1', owner: 'host:1:a' }), false);
        assert.equal(await fileExists({ file }), true);

        assert.equal(await store.release({ workItemId: 'MER-1', owner: 'host:1:a' }), true);
        assert.equal(await fileExists({ file }), false);
        assert.equal(await store.isClaimed({ workItemId: 'MER-1' }), false);
    } });
});

test('file: release of a missing claim is false', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const store = createFileClaimStore({ dir, hostId: 'this-host' });
        assert.equal(await store.release({ workItemId: 'MER-1', owner: 'host:1:a' }), false);
    } });
});

// ---------------------------------------------------------------------------
// File claim store: pid liveness and staleness
// ---------------------------------------------------------------------------

test('file: a dead pid is reclaimed by a different owner', async (t) => {
    const pid = await spawnShortLivedChild();
    if (isAlive(pid)) {
        t.skip('the child pid is still alive; the dead-pid path cannot be tested');
        return;
    }
    assert.throws(() => process.kill(pid, 0), (error) => /** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH');

    await withTempDir({ fn: async ({ dir }) => {
        const store = createFileClaimStore({ dir, hostId: 'this-host', staleMs: 60_000, now: () => 1_000 });
        const file = claimFile({ dir, workItemId: 'MER-1' });
        // Fresh by the clock, but the owner process is gone.
        await seedClaim({ file, record: claimRecord({ workItemId: 'MER-1', owner: 'ghost', pid, host: 'this-host', claimedAt: 1_000 }) });

        assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'host:1:new' }), true);
        assert.equal((await readClaim({ file })).owner, 'host:1:new');
    } });
});

test('file: a live pid with a token this process never issued is reclaimed', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        // A container restart keeps the host and reuses a small pid, so a live
        // pid alone does not prove the holder is still alive (F2-3).
        const store = createFileClaimStore({ dir, hostId: 'this-host', staleMs: 86_400_000, now: () => 10_000 });
        const file = claimFile({ dir, workItemId: 'MER-1' });
        await seedClaim({
            file,
            record: claimRecord({ workItemId: 'MER-1', owner: 'host:1:dead-incarnation', pid: process.pid, host: 'this-host', claimedAt: 10_000 })
        });

        assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'host:1:b' }), true);
        assert.equal((await readClaim({ file })).owner, 'host:1:b');
    } });
});

test('file: a live pid with a token this process issued is displaced once claimedAt passes staleMs', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        // Same process, live pid, token issued here: only the age clause can
        // free the claim, and W2D-9 asks that it does.
        const store = createFileClaimStore({ dir, hostId: 'this-host', staleMs: 1_000 });
        const file = claimFile({ dir, workItemId: 'MER-1' });
        assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'host:1:aged', now: 10_000 }), true);

        assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'host:1:b', now: 11_000 }), false);
        assert.equal((await readClaim({ file })).owner, 'host:1:aged');

        assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'host:1:b', now: 11_001 }), true);
        assert.equal((await readClaim({ file })).owner, 'host:1:b');
    } });
});

test('file: deactivating an owner makes its leftover claim reclaimable at once', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const owner = `host:${process.pid}:retired`;
        const store = createFileClaimStore({ dir, hostId: 'this-host', staleMs: 86_400_000, now: () => 1_000 });
        activateClaimOwner({ owner });
        assert.equal(await store.acquire({ workItemId: 'MER-1', owner }), true);
        assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'host:1:b' }), false, 'a live owner keeps it');

        deactivateClaimOwner({ owner });
        // The instance stopped and its token is pruned, so the leftover file is
        // a claim of no live owner: reclaimed immediately, not in six hours.
        assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'host:1:b' }), true);
    } });
});

test('file: a foreign host is reclaimed only past a strictly greater staleMs', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const nowMs = 5_000;
        const store = createFileClaimStore({ dir, hostId: 'this-host', staleMs: 1_000, now: () => nowMs });

        const stale = 'MER-STALE';
        await seedClaim({
            file: claimFile({ dir, workItemId: stale }),
            record: claimRecord({ workItemId: stale, owner: 'remote', host: 'other-host', claimedAt: nowMs - 1_001 })
        });
        assert.equal(await store.acquire({ workItemId: stale, owner: 'host:1:new' }), true);

        const exact = 'MER-EXACT';
        await seedClaim({
            file: claimFile({ dir, workItemId: exact }),
            record: claimRecord({ workItemId: exact, owner: 'remote', host: 'other-host', claimedAt: nowMs - 1_000 })
        });
        assert.equal(await store.acquire({ workItemId: exact, owner: 'host:1:new' }), false);
        assert.equal((await readClaim({ file: claimFile({ dir, workItemId: exact }) })).owner, 'remote');

        const fresh = 'MER-FRESH';
        await seedClaim({
            file: claimFile({ dir, workItemId: fresh }),
            record: claimRecord({ workItemId: fresh, owner: 'remote', host: 'other-host', claimedAt: nowMs })
        });
        assert.equal(await store.acquire({ workItemId: fresh, owner: 'host:1:new' }), false);
        assert.equal((await readClaim({ file: claimFile({ dir, workItemId: fresh }) })).owner, 'remote');
    } });
});

test('file: acquire now overrides the store clock for both claimedAt and staleness', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const store = createFileClaimStore({ dir, hostId: 'this-host', staleMs: 1_000, now: () => 5_000 });

        await store.acquire({ workItemId: 'MER-NOW', owner: 'host:1:a', now: 7_777 });
        assert.equal((await readClaim({ file: claimFile({ dir, workItemId: 'MER-NOW' }) })).claimedAt, 7_777);

        // The store clock says 5_000, the call says 6_001: 1_001 ms of staleness
        // on a foreign claim, so it is reclaimable.
        await seedClaim({
            file: claimFile({ dir, workItemId: 'MER-CLOCK' }),
            record: claimRecord({ workItemId: 'MER-CLOCK', owner: 'remote', host: 'other-host', claimedAt: 5_000 })
        });
        assert.equal(await store.acquire({ workItemId: 'MER-CLOCK', owner: 'host:1:b', now: 6_001 }), true);
    } });
});

test('file: eight concurrent reclaims of one stale claim elect at least one winner without corrupting the claim, 100 times', async () => {
    // The module note (claims.mjs): with N > 2 synchronized reclaimers several may
    // each return true. This pins the documented bound, not exactly one.
    for (let iteration = 0; iteration < 100; iteration += 1) {
        const dir = await fs.mkdtemp(join(tmpdir(), 'merci-claims-race-'));
        try {
            const file = claimFile({ dir, workItemId: 'MER-RACE' });
            await seedClaim({
                file,
                record: claimRecord({ workItemId: 'MER-RACE', owner: 'remote', host: 'other-host', claimedAt: 0 })
            });

            // Each contender is its own store instance with its own owner, as
            // independent schedulers would be.
            const contenders = Array.from({ length: 8 }, (_, index) => ({
                owner: `host:${process.pid}:contender-${index}`,
                store: createFileClaimStore({ dir, hostId: 'this-host', staleMs: 100, now: () => 10_000 })
            }));
            const outcomes = await Promise.all(
                contenders.map(({ store, owner }) => store.acquire({ workItemId: 'MER-RACE', owner }))
            );

            // Derived by index, so every winner is one of the contenders.
            const winners = contenders.filter((_, index) => outcomes[index]);
            assert.ok(winners.length >= 1, `iteration ${iteration}: expected at least one winner`);
            assert.equal(winners.length, outcomes.filter(Boolean).length);

            const final = await readClaim({ file });
            assert.equal(final.workItemId, 'MER-RACE', 'the final claim file is a valid record');
            assert.ok(Number.isInteger(final.pid) && Number(final.pid) > 0, 'the record carries a valid pid');
            assert.equal(final.host, 'this-host');
            assert.ok(
                winners.some(({ owner }) => owner === final.owner),
                `iteration ${iteration}: the final claim is owned by one of the winners`
            );
            const pins = (await fs.readdir(dir)).filter((name) => name.startsWith(`${workspaceKeyFor({ workItemId: 'MER-RACE' })}.json.reclaim.`));
            assert.deepEqual(pins, [], `iteration ${iteration}: no reclaim pin is left behind`);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    }
});

test('file: two concurrent reclaims of one stale claim elect exactly one winner', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const file = claimFile({ dir, workItemId: 'MER-TWO' });
        await seedClaim({
            file,
            record: claimRecord({ workItemId: 'MER-TWO', owner: 'remote', host: 'other-host', claimedAt: 0 })
        });
        const contenders = Array.from({ length: 2 }, (_, index) => ({
            owner: `host:${process.pid}:contender-${index}`,
            store: createFileClaimStore({ dir, hostId: 'this-host', staleMs: 100, now: () => 10_000 })
        }));
        const outcomes = await Promise.all(
            contenders.map(({ store, owner }) => store.acquire({ workItemId: 'MER-TWO', owner }))
        );

        assert.equal(outcomes.filter(Boolean).length, 1, 'two contenders elect exactly one winner');
        const winner = contenders[outcomes.indexOf(true)];
        assert.equal((await readClaim({ file })).owner, winner.owner);
        const pins = (await fs.readdir(dir)).filter((name) => name.startsWith(`${workspaceKeyFor({ workItemId: 'MER-TWO' })}.json.reclaim.`));
        assert.deepEqual(pins, [], 'no reclaim pin is left behind');
    } });
});

test('file: a successful reclaim leaves no pin entry behind and list never returns one', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const store = createFileClaimStore({ dir, hostId: 'this-host', staleMs: 100, now: () => 10_000 });
        const file = claimFile({ dir, workItemId: 'MER-PIN' });
        const leftoverPin = `${workspaceKeyFor({ workItemId: 'MER-PIN' })}.json.reclaim.leftover`;
        await seedClaim({
            file,
            record: claimRecord({ workItemId: 'MER-PIN', owner: 'remote', host: 'other-host', claimedAt: 0 })
        });
        // A pin-shaped file that holds a valid record: `list` must ignore it on
        // the name, not merely fail to find it after cleanup.
        await seedClaim({
            file: join(dir, leftoverPin),
            record: claimRecord({ workItemId: 'MER-PIN-LEFTOVER', owner: 'remote', host: 'other-host', claimedAt: 0 })
        });
        assert.deepEqual((await fs.readdir(dir)).filter((name) => name.includes('.reclaim.')), [leftoverPin]);
        assert.deepEqual(await store.list(), ['MER-PIN']);

        assert.equal(await store.acquire({ workItemId: 'MER-PIN', owner: 'host:1:new' }), true);

        assert.deepEqual((await fs.readdir(dir)).filter((name) => name.includes('.reclaim.')), [leftoverPin]);
        assert.equal((await readClaim({ file })).owner, 'host:1:new');
        assert.deepEqual(await store.list(), ['MER-PIN']);
    } });
});

// ---------------------------------------------------------------------------
// File claim store: fail-closed reads and listing
// ---------------------------------------------------------------------------

test('file: an unreadable claim file fails every operation closed and is never unlinked', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const store = createFileClaimStore({ dir, hostId: 'this-host' });

        for (const body of ['{ not json', JSON.stringify({ owner: 'ghost' })]) {
            const file = claimFile({ dir, workItemId: 'MER-BAD' });
            await fs.writeFile(file, body);
            const before = await fs.readFile(file);

            assert.equal(await store.isClaimed({ workItemId: 'MER-BAD' }), true);
            assert.equal(await store.acquire({ workItemId: 'MER-BAD', owner: 'host:1:a' }), false);
            assert.equal(await store.release({ workItemId: 'MER-BAD', owner: 'ghost' }), false);
            assert.deepEqual(await fs.readFile(file), before);
        }

        // A read that throws (EISDIR here) is unreadable too, and the entry is
        // left exactly where it was.
        const asDirectory = claimFile({ dir, workItemId: 'MER-DIR' });
        await fs.mkdir(asDirectory);
        assert.equal(await store.isClaimed({ workItemId: 'MER-DIR' }), true);
        assert.equal(await store.acquire({ workItemId: 'MER-DIR', owner: 'host:1:a' }), false);
        assert.equal(await store.release({ workItemId: 'MER-DIR', owner: 'host:1:a' }), false);
        assert.equal((await fs.stat(asDirectory)).isDirectory(), true);
    } });
});

test('file: list skips unreadable claims and still returns the healthy ids', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const store = createFileClaimStore({ dir, hostId: 'this-host' });
        await store.acquire({ workItemId: 'MER-OK', owner: 'host:1:a' });
        await fs.writeFile(claimFile({ dir, workItemId: 'MER-BAD' }), '{ not json');

        assert.deepEqual(await store.list(), ['MER-OK']);
    } });
});

// ---------------------------------------------------------------------------
// File claim store: filesystem and option edges
// ---------------------------------------------------------------------------

test('file: acquire creates a missing directory, list of a missing directory is empty', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const target = join(dir, 'nested', 'claims');
        const store = createFileClaimStore({ dir: target, hostId: 'this-host' });

        assert.deepEqual(await store.list(), []);
        assert.equal(await store.acquire({ workItemId: 'MER-1', owner: 'host:1:a' }), true);
        assert.equal(await fileExists({ file: claimFile({ dir: target, workItemId: 'MER-1' }) }), true);
    } });
});

test('file: a directory path that is a file makes acquire reject without touching it', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const notDir = join(dir, 'claims.txt');
        await fs.writeFile(notDir, 'not a directory');
        const store = createFileClaimStore({ dir: notDir, hostId: 'this-host' });

        await assert.rejects(store.acquire({ workItemId: 'MER-1', owner: 'host:1:a' }));
        // list cannot readdir a file either: the ENOENT fallback does not hide it.
        await assert.rejects(store.list());
        assert.equal(await fs.readFile(notDir, 'utf8'), 'not a directory');
    } });
});

test('file: an unwritable claims directory makes the reclaim fail closed and leaves the claim intact', async (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        t.skip('running as root: directory permission bits do not apply');
        return;
    }
    await withTempDir({ fn: async ({ dir }) => {
        const store = createFileClaimStore({ dir, hostId: 'this-host', staleMs: 100, now: () => 10_000 });
        const file = claimFile({ dir, workItemId: 'MER-NOLINK' });
        await seedClaim({
            file,
            record: claimRecord({ workItemId: 'MER-NOLINK', owner: 'remote', host: 'other-host', claimedAt: 0 })
        });
        const before = await fs.readFile(file);

        // `link` needs a writable directory; without it the election cannot
        // create its pin, so a stale claim is never removed.
        await fs.chmod(dir, 0o500);
        try {
            assert.equal(await store.acquire({ workItemId: 'MER-NOLINK', owner: 'host:1:new' }), false);
            assert.deepEqual(await fs.readFile(file), before);
        } finally {
            await fs.chmod(dir, 0o700);
        }
    } });
});

test('file: every option is validated with its option name', async () => {
    throwsConfiguration({ run: () => createFileClaimStore({}), option: 'dir' });
    throwsConfiguration({ run: () => createFileClaimStore({ dir: '' }), option: 'dir' });
    throwsConfiguration({ run: () => createFileClaimStore({ dir: 42 }), option: 'dir' });
    throwsConfiguration({ run: () => createFileClaimStore({ dir: 'x', staleMs: -1 }), option: 'staleMs' });
    throwsConfiguration({ run: () => createFileClaimStore({ dir: 'x', staleMs: Infinity }), option: 'staleMs' });
    throwsConfiguration({ run: () => createFileClaimStore({ dir: 'x', staleMs: Number.NaN }), option: 'staleMs' });
    throwsConfiguration({ run: () => createFileClaimStore({ dir: 'x', now: 42 }), option: 'now' });
    throwsConfiguration({ run: () => createFileClaimStore({ dir: 'x', hostId: '' }), option: 'hostId' });
    // The documented defaults are accepted.
    assert.equal(typeof createFileClaimStore({ dir: 'x' }).acquire, 'function');
});

test('both stores: acquire and release require a non-empty owner', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        for (const store of [createMemoryClaimStore(), createFileClaimStore({ dir, hostId: 'this-host' })]) {
            /** @typedef {(arg0: {workItemId: string, owner?: string}) => Promise<boolean>} LooseAcquire */
            const acquireWithoutOwner = /** @type {LooseAcquire} */ (/** @type {unknown} */ (store.acquire));

            await rejectsConfiguration({ run: () => store.acquire({ workItemId: 'MER-1', owner: '' }), option: 'owner' });
            await rejectsConfiguration({ run: () => store.acquire({ workItemId: 'MER-1', owner: '   ' }), option: 'owner' });
            await rejectsConfiguration({ run: () => acquireWithoutOwner({ workItemId: 'MER-1' }), option: 'owner' });
            await rejectsConfiguration({ run: () => store.release({ workItemId: 'MER-1', owner: '' }), option: 'owner' });
        }
    } });
});

test('both stores: acquire and release reject a non-string or empty workItemId without changing state', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        for (const store of [createMemoryClaimStore(), createFileClaimStore({ dir, hostId: 'this-host' })]) {
            const loose = /** @type {any} */ (store);

            await rejectsConfiguration({ run: () => loose.acquire({ workItemId: 42, owner: 'a' }), option: 'workItemId' });
            await rejectsConfiguration({ run: () => loose.acquire({ workItemId: '', owner: 'a' }), option: 'workItemId' });
            await rejectsConfiguration({ run: () => loose.release({ workItemId: 42, owner: 'a' }), option: 'workItemId' });
            await rejectsConfiguration({ run: () => loose.release({ workItemId: '', owner: 'a' }), option: 'workItemId' });
            assert.deepEqual(await store.list(), []);
        }
        assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith('.json')), []);
    } });
});

test('both stores: a per-call now must be a finite number when provided', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        for (const store of [createMemoryClaimStore(), createFileClaimStore({ dir, hostId: 'this-host' })]) {
            const loose = /** @type {any} */ (store);

            await rejectsConfiguration({ run: () => loose.acquire({ workItemId: 'MER-NOW', owner: 'a', now: Number.NaN }), option: 'now' });
            await rejectsConfiguration({ run: () => loose.acquire({ workItemId: 'MER-NOW', owner: 'a', now: '999' }), option: 'now' });
            assert.deepEqual(await store.list(), []);
        }
        assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith('.json')), []);
    } });
});

test('file: a claim record with pid 0 or a fractional pid is unreadable and never touched', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const store = createFileClaimStore({ dir, hostId: 'this-host', staleMs: 0, now: () => 1_000_000 });

        for (const { workItemId, pid } of [{ workItemId: 'MER-PID0', pid: 0 }, { workItemId: 'MER-PIDFRAC', pid: 1.5 }]) {
            const file = claimFile({ dir, workItemId });
            await seedClaim({
                file,
                record: claimRecord({ workItemId, owner: 'ghost', pid, host: 'this-host', claimedAt: 0 })
            });
            const before = await fs.readFile(file);

            assert.equal(await store.acquire({ workItemId, owner: 'host:1:new' }), false);
            assert.equal(await store.release({ workItemId, owner: 'ghost' }), false);
            assert.deepEqual(await fs.readFile(file), before);
        }
    } });
});

test('file: identifiers that sanitize to the same text get distinct files and both acquire', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const store = createFileClaimStore({ dir, hostId: 'this-host' });
        const slash = claimFile({ dir, workItemId: 'a/b' });
        const space = claimFile({ dir, workItemId: 'a b' });
        assert.notEqual(slash, space);

        assert.equal(await store.acquire({ workItemId: 'a/b', owner: 'host:1:a' }), true);
        assert.equal(await store.acquire({ workItemId: 'a b', owner: 'host:1:b' }), true);
        assert.deepEqual(await store.list(), ['a b', 'a/b']);
        assert.equal(await fileExists({ file: slash }), true);
        assert.equal(await fileExists({ file: space }), true);
    } });
});

test('file: the default host is the local hostname', async () => {
    await withTempDir({ fn: async ({ dir }) => {
        const store = createFileClaimStore({ dir });
        await store.acquire({ workItemId: 'MER-1', owner: 'host:1:a' });
        assert.equal((await readClaim({ file: claimFile({ dir, workItemId: 'MER-1' }) })).host, hostname());
    } });
});
