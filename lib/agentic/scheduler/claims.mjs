// @ts-check


/**
 * @file Claim stores: the in-process map and the O_EXCL claim file.
 * @version 0.12.0
 *
 * @description
 * A claim is the scheduler's guarantee that one work item has one owner for the
 * continuous active life of an item: retries, continuations, and parking keep
 * it; only a terminal/inactive/missing item, a stop, or `resetItem()` releases
 * it. `workItemId` here is the scheduler's stable identifier (RC-03), named for
 * symmetry with the workspace contract, where the same external key is also
 * called `workItemId`. `owner` is opaque to the store; the scheduler builds a
 * process-unique `host:pid:uuid` token.
 *
 * `createMemoryClaimStore()` is the default: a `Map`, no IO, no restart
 * survival. `createFileClaimStore()` adds a second-process guard on one
 * machine. One file per identifier at `<dir>/<key>.json`, where `key` is
 * `workspaceKeyFor({ workItemId })` — the same deterministic key the workspace
 * slice derives, so one identifier has one key across the SDK. The claim file
 * simply appends `.json`; it is never a workspace path.
 *
 * The lock is `writeFile(..., { flag: 'wx' })` (O_EXCL). `writeJsonAtomic` is
 * deliberately not used for the create: it is tmp+rename, so two writers both
 * succeed and the last rename wins — no mutual exclusion. Reads go through
 * `readStoredJson` (`support/fs-store.mjs`), the repo's durable-JSON primitive.
 *
 * A stale claim is reclaimed with a hard-link + inode compare-and-swap, not a
 * rename. The reclaimer links the claim path to a unique pin, re-reads the pin
 * and requires the same claim record, then checks that the pin and the claim
 * path still name the same inode (`dev`/`ino`) before it unlinks the path.
 *
 * That is a second-process guard on one machine, not a cluster lock. Verified
 * at that scale: 0 double wins in 120 fresh two-process reclaim races (both
 * holders live) and 0 in 200 in-process 8-way runs. The `stat`→`unlink` pair is
 * not atomic, so a duplicate is not *proven* impossible even at two; the
 * observed rate is 0 at that scale. With N > 2 synchronized reclaimers of one
 * stale claim, several can each return `true`: each later winner unlinks the
 * previous winner's fresh claim. Under a widened window 3–6 of 8 won; the rate
 * is schedule-dependent. The cost is a duplicate dispatch and the displaced
 * owner's claim file — it can no longer release and may run alongside the last
 * winner — never user-data loss. Hard links are required (POSIX/APFS/ext4);
 * where `link` is unsupported the reclaim fails closed with `false` and the
 * item is not reclaimed. The stronger fix, out of scope for this slice, is
 * generational `wx` claim files: the highest generation wins and a takeover
 * creates `gen+1`, which removes the unlink window entirely.
 *
 * Failure policy is safety over liveness. A claim left by a crash is reclaimed
 * through the dead-pid, stopped-owner, or stale path. A torn (partially
 * written) claim is indistinguishable from an unreadable one, so it blocks
 * until someone removes it by hand; nothing here unlinks a file it could not
 * parse. A same-host holder keeps its claim while its pid is alive, its token
 * belongs to a live owner in this process, and its age is within `staleMs`; a
 * token no live owner holds (a restarted container that reused the pid, or an
 * instance that stopped) is reclaimed at once, and an age past `staleMs` means
 * the heartbeat stopped. `refresh()` is that heartbeat: it rewrites `claimedAt`
 * for the current owner only, and never creates or steals a claim. The pid
 * check assumes one machine and one pid namespace; a claim file on a shared
 * filesystem is not protected across containers.
 *
 * The pid-liveness check lives in `support/utils.mjs` so the memory provider and
 * this store agree on it; the O_EXCL create stays local because the two stores'
 * failure modes differ (wait/retry/deadline, a reclaim marker).
 */
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { readStoredJson, writeJsonAtomic } from '../../support/fs-store.mjs';
import { isProcessAlive } from '../../support/utils.mjs';
import { assertNonEmptyString } from '../../support/validation.mjs';
import { workspaceKeyFor } from '../workspace/keys.mjs';

/**
 * Owner tokens a live scheduler in this process may hold claims with. Every
 * `acquire` registers its token; `deactivateClaimOwner` removes it when that
 * instance stops, so the set stays bounded by the live instances instead of
 * growing one entry per restart (W2D-10). A same-host claim whose pid is this
 * process but whose token is absent was left behind by a stopped instance or an
 * earlier process that reused the pid, so it is stale whatever its age (F2-3,
 * W2D-2). Module-scoped on purpose: every store in the process shares it.
 * @type {Set<string>}
 */
const liveOwners = new Set();

/**
 * Register an owner token as live. `start()` calls this, and `acquire` calls it
 * for a store used without a scheduler.
 * @param {{owner: string}} arg0 -
 * @returns {void}
 */
export function activateClaimOwner({ owner }) {
    liveOwners.add(owner);
}

/**
 * Drop an owner token: the instance that used it has stopped, so any claim file
 * still naming it is nobody's live claim.
 * @param {{owner: string}} arg0 -
 * @returns {void}
 */
export function deactivateClaimOwner({ owner }) {
    liveOwners.delete(owner);
}

/**
 * The claim-store contract. `refresh` is the optional heartbeat: it returns
 * true only while `owner` still holds the claim, and never creates or steals
 * one. A store without it is simply not heartbeated.
 * @typedef {Object} ClaimStore
 * @property {(arg0: { workItemId: string, owner: string, now?: number }) => Promise<boolean>} acquire
 * @property {(arg0: { workItemId: string, owner: string }) => Promise<boolean>} release
 * @property {(arg0: { workItemId: string, owner: string, now?: number }) => Promise<boolean>} [refresh]
 * @property {(arg0: { workItemId: string }) => Promise<boolean>} isClaimed
 * @property {() => Promise<string[]>} list
 */

/**
 * The record one claim file holds. `pid` and `host` are written by the owner;
 * `claimedAt` is the store clock (or the per-call override) in epoch ms.
 * @typedef {Object} ClaimRecord
 * @property {string} workItemId
 * @property {string} owner
 * @property {number} pid
 * @property {string} host
 * @property {number} claimedAt
 */

/**
 * An empty owner token can never release what it acquired, so it is a caller
 * bug, not a lost claim.
 * @param {{owner: unknown}} arg0
 * @returns {void}
 * @throws {ConfigurationError} When `owner` is not a non-empty string.
 */
function assertOwner({ owner }) {
    assertNonEmptyString({ value: owner, name: 'owner' });
}

/**
 * `workItemId` is the scheduling key. A non-string or empty value is a caller
 * bug: it would otherwise write a record that `isClaimRecord` rejects, leaving a
 * claim no operation can read.
 * @param {{workItemId: unknown}} arg0 -
 * @returns {void}
 * @throws {ConfigurationError} When `workItemId` is not a non-empty string.
 */
function assertWorkItemId({ workItemId }) {
    assertNonEmptyString({ value: workItemId, name: 'workItemId' });
}

/**
 * A per-call clock override must be a finite number when present; `NaN` would
 * write `claimedAt: null` and a string would be silently ignored.
 * @param {{now?: unknown}} arg0 -
 * @returns {void}
 * @throws {ConfigurationError} When `now` is present but not a finite number.
 */
function assertNowOverride({ now }) {
    if (now !== undefined && (typeof now !== 'number' || !Number.isFinite(now))) {
        throw new ConfigurationError({ message: 'now must be a finite number when provided.', options: { option: 'now' } });
    }
}

/**
 * A claim file is usable only with every documented field at its documented
 * type. A partial shape is unreadable, never repaired. `pid` must be a positive
 * integer: `0` targets the process group, so it is as invalid as a fraction.
 * @param {unknown} value
 * @returns {value is ClaimRecord}
 */
function isClaimRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = /** @type {Record<string, unknown>} */ (value);
    return typeof record.workItemId === 'string'
        && typeof record.owner === 'string'
        && typeof record.host === 'string'
        && Number.isInteger(record.pid)
        && /** @type {number} */ (record.pid) > 0
        && typeof record.claimedAt === 'number';
}

/**
 * The pin must hold exactly the record the reclaimer decided was stale.
 * @param {{value: unknown, stale: ClaimRecord}} arg0 -
 * @returns {boolean}
 */
function sameClaim({ value, stale }) {
    if (typeof value !== 'object' || value === null) return false;
    const record = /** @type {Record<string, unknown>} */ (value);
    return record.workItemId === stale.workItemId
        && record.owner === stale.owner
        && record.claimedAt === stale.claimedAt
        && record.pid === stale.pid
        && record.host === stale.host;
}

/**
 * In-process claim store. The default; a claim dies with the process.
 * @returns {ClaimStore}
 */
export function createMemoryClaimStore() {
    /** @type {Map<string, {owner: string, claimedAt: number}>} */
    const claims = new Map();
    return {
        async acquire({ workItemId, owner, now }) {
            assertWorkItemId({ workItemId });
            assertOwner({ owner });
            assertNowOverride({ now });
            const existing = claims.get(workItemId);
            if (!existing) {
                claims.set(workItemId, { owner, claimedAt: now ?? Date.now() });
                return true;
            }
            // Idempotent for the same owner: a retry or continuation must not
            // move the claim's start time.
            return existing.owner === owner;
        },
        async release({ workItemId, owner }) {
            assertWorkItemId({ workItemId });
            assertOwner({ owner });
            const existing = claims.get(workItemId);
            if (!existing || existing.owner !== owner) return false;
            claims.delete(workItemId);
            return true;
        },
        /**
         * The heartbeat. This store has no staleness, so the start time does not
         * move; the answer is whether this owner still holds the claim.
         * @param {{workItemId: string, owner: string}} arg0 -
         * @returns {Promise<boolean>}
         */
        async refresh({ workItemId, owner }) {
            assertWorkItemId({ workItemId });
            assertOwner({ owner });
            const existing = claims.get(workItemId);
            return existing !== undefined && existing.owner === owner;
        },
        async isClaimed({ workItemId }) {
            return claims.has(workItemId);
        },
        async list() {
            return [...claims.keys()];
        }
    };
}

/**
 * File-backed claim store: one `<key>.json` per identifier.
 * @param {{dir?: unknown, staleMs?: unknown, hostId?: unknown, now?: unknown}} [arg0] -
 * @returns {ClaimStore}
 * @throws {ConfigurationError} When `dir`, `staleMs`, `hostId`, or `now` is invalid.
 */
export function createFileClaimStore({ dir, staleMs = LIMITS.claim_stale_ms, hostId = hostname(), now = Date.now } = {}) {
    if (typeof dir !== 'string' || dir.trim() === '') {
        throw new ConfigurationError({ message: 'dir must be a non-empty string.', options: { option: 'dir' } });
    }
    if (typeof staleMs !== 'number' || !Number.isFinite(staleMs) || staleMs < 0) {
        throw new ConfigurationError({ message: 'staleMs must be a finite number >= 0.', options: { option: 'staleMs' } });
    }
    if (typeof hostId !== 'string' || hostId.trim() === '') {
        throw new ConfigurationError({ message: 'hostId must be a non-empty string.', options: { option: 'hostId' } });
    }
    if (typeof now !== 'function') {
        throw new ConfigurationError({ message: 'now must be a function returning epoch milliseconds.', options: { option: 'now' } });
    }

    /**
     * @param {{workItemId: string}} arg0 -
     * @returns {string}
     */
    const fileFor = ({ workItemId }) => join(dir, `${workspaceKeyFor({ workItemId })}.json`);

    /**
     * The read every claim decision goes through. Any read error, corrupt
     * content, or partial shape is `unreadable`, and the caller must fail closed.
     * @param {{filePath: string}} arg0 -
     * @returns {Promise<{status: 'ok', record: ClaimRecord}|{status: 'missing'|'unreadable'}>}
     */
    async function readClaim({ filePath }) {
        let stored;
        try {
            stored = await readStoredJson({ filePath });
        } catch {
            return { status: 'unreadable' };
        }
        if (stored.status === 'missing') return { status: 'missing' };
        if (stored.status !== 'ok' || !isClaimRecord(stored.value)) return { status: 'unreadable' };
        return { status: 'ok', record: stored.value };
    }

    /**
     * The create is the lock: `wx` fails with `EEXIST` when another owner holds
     * the path.
     * @param {{filePath: string, record: ClaimRecord}} arg0 -
     * @returns {Promise<boolean>}
     */
    async function createExclusive({ filePath, record }) {
        try {
            await fs.writeFile(filePath, JSON.stringify(record), { flag: 'wx' });
            return true;
        } catch (err) {
            if (/** @type {any} */ (err)?.code === 'EEXIST') return false;
            throw err;
        }
    }

    /**
     * The reclaim election is a hard link plus an inode compare-and-swap. The
     * pin holds the stale inode; the path is unlinked only after the pin's
     * content matches the record read before the decision and both paths still
     * name the same inode. The `stat`→`unlink` pair is not atomic, so a second
     * process can still unlink a claim that was re-created in between (the
     * module note gives the measured bound). The one retry of the exclusive
     * create follows; `EEXIST` means another reclaimer won.
     * @param {{filePath: string, record: ClaimRecord, stale: ClaimRecord}} arg0 -
     * @returns {Promise<boolean>}
     */
    async function reclaim({ filePath, record, stale }) {
        const pin = `${filePath}.reclaim.${randomUUID()}`;
        try {
            await fs.link(filePath, pin);
        } catch {
            // The path is gone, or the filesystem has no hard links.
            return false;
        }
        try {
            const pinned = await readStoredJson({ filePath: pin });
            if (pinned.status !== 'ok' || !sameClaim({ value: pinned.value, stale })) return false;
            let pinStat;
            let targetStat;
            try {
                pinStat = await fs.stat(pin);
                targetStat = await fs.stat(filePath);
            } catch {
                return false;
            }
            if (pinStat.dev !== targetStat.dev || pinStat.ino !== targetStat.ino) return false;
            try {
                await fs.unlink(filePath);
            } catch {
                return false;
            }
        } finally {
            await fs.unlink(pin).catch(() => {});
        }
        return createExclusive({ filePath, record });
    }

    /**
     * The heartbeat write: refresh `claimedAt` only while `owner` still holds
     * the claim. A missing file, another owner, or another host is left alone,
     * so a heartbeat can never create or steal a claim (W2D-3). The write is
     * best effort: the claim is still the owner's even when the refresh fails.
     * @param {{filePath: string, owner: string, claimedAt: number}} arg0 -
     * @returns {Promise<boolean>}
     */
    async function refreshClaim({ filePath, owner, claimedAt }) {
        const existing = await readClaim({ filePath });
        if (existing.status !== 'ok') return false;
        if (existing.record.owner !== owner || existing.record.host !== hostId) return false;
        await writeJsonAtomic({ filePath, data: { ...existing.record, claimedAt } }).catch(() => {});
        return true;
    }

    return {
        async acquire({ workItemId, owner, now: nowOverride }) {
            assertWorkItemId({ workItemId });
            assertOwner({ owner });
            assertNowOverride({ now: nowOverride });
            liveOwners.add(owner);
            const filePath = fileFor({ workItemId });
            const claimedAt = nowOverride ?? now();
            /** @type {ClaimRecord} */
            const record = { workItemId, owner, pid: process.pid, host: hostId, claimedAt };

            await fs.mkdir(dir, { recursive: true });
            if (await createExclusive({ filePath, record })) return true;

            const existing = await readClaim({ filePath });
            if (existing.status !== 'ok') return false;
            const holder = existing.record;
            if (holder.owner === owner) {
                // A same-owner re-acquire is the heartbeat: refresh the age, or
                // a claim held across a retry, a continuation, or a park ages
                // past `staleMs` and a foreign host displaces it (F2-7).
                await refreshClaim({ filePath, owner, claimedAt });
                return true;
            }

            if (holder.host === hostId) {
                if (isProcessAlive({ pid: holder.pid })) {
                    // A claim of no live owner in this process (a stopped
                    // instance, or an earlier process that reused this pid) is
                    // reclaimed whatever its age (F2-3, W2D-2). Otherwise only
                    // a stopped heartbeat frees it.
                    const orphaned = holder.pid === process.pid && !liveOwners.has(holder.owner);
                    if (!orphaned && claimedAt - holder.claimedAt <= staleMs) return false;
                }
            } else if (claimedAt - holder.claimedAt <= staleMs) {
                // A pid on another host is not ours to test: only age decides,
                // and the boundary is strict (`>`).
                return false;
            }
            return reclaim({ filePath, record, stale: holder });
        },
        /**
         * The heartbeat the scheduler calls each tick: it never creates a claim
         * and never displaces one, so a release that raced it wins (W2D-3).
         * @param {{workItemId: string, owner: string, now?: number}} arg0 -
         * @returns {Promise<boolean>}
         */
        async refresh({ workItemId, owner, now: nowOverride }) {
            assertWorkItemId({ workItemId });
            assertOwner({ owner });
            assertNowOverride({ now: nowOverride });
            return refreshClaim({ filePath: fileFor({ workItemId }), owner, claimedAt: nowOverride ?? now() });
        },
        async release({ workItemId, owner }) {
            assertWorkItemId({ workItemId });
            assertOwner({ owner });
            const filePath = fileFor({ workItemId });
            const existing = await readClaim({ filePath });
            if (existing.status !== 'ok') return false;
            // Both halves of the owner token must match; a different host can
            // never release this host's claim.
            if (existing.record.owner !== owner || existing.record.host !== hostId) return false;
            try {
                await fs.unlink(filePath);
                return true;
            } catch {
                return false;
            }
        },
        /**
         * Diagnostic only: a file that exists counts even when unreadable, and
         * eligibility never consults this. An unusable key (for example a
         * number) fails closed as `false` instead of throwing.
         * @param {{workItemId: string}} arg0 -
         * @returns {Promise<boolean>}
         */
        async isClaimed({ workItemId }) {
            try {
                await fs.stat(fileFor({ workItemId }));
                return true;
            } catch {
                return false;
            }
        },
        async list() {
            /** @type {string[]} */
            const names = await fs.readdir(dir).catch((err) => {
                if (/** @type {any} */ (err)?.code === 'ENOENT') return [];
                throw err;
            });
            /** @type {string[]} */
            const workItemIds = [];
            for (const name of names) {
                if (!name.endsWith('.json')) continue;
                const existing = await readClaim({ filePath: join(dir, name) });
                if (existing.status === 'ok') workItemIds.push(existing.record.workItemId);
            }
            return workItemIds.sort();
        }
    };
}
