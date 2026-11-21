// @ts-check

/**
 * @file The inbox store — where a durable queue of submitted messages lives.
 * @version 0.12.0
 *
 * @description
 * `withInboxStore()` makes the session inbox outlive the process: the rows
 * `enqueueInput` accepted are written after every change and loaded before the
 * first turn, so a host that restarts — or a browser tab that reconnects — does
 * not strand what the user sent.
 *
 * The store holds a snapshot of the PENDING rows, in delivery order, under one
 * thread id. A row leaves the store when a turn claims it, so the durable
 * contract is the in-memory one: at-least-once (a crash between the claim and
 * the next write re-delivers it) and never a silent drop.
 *
 * The key is the conversation, not the process: `withSessionStore()`'s
 * `threadId` is reused when the host set one, so the queue survives a restart
 * next to the checkpoint it belongs to.
 *
 * Two implementations ship, mirroring `SessionStore`:
 * `InMemoryInboxStore` (tests, or a host that persists elsewhere) and
 * `LocalFileInboxStore` (one atomic JSON file per thread).
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { ConfigurationError } from '../core/errors.mjs';
import { sdkWarn } from '../support/utils.mjs';
import { quarantineFile, readStoredJson, writeJsonAtomic } from '../support/fs-store.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { createFileClaimStore, createMemoryClaimStore } from './scheduler/claims.mjs';

/** The on-disk shape every inbox store speaks. */
export const INBOX_STORE_VERSION = 1;

/**
 * The lease one drainer holds while it works a thread's queue. `acquire` is
 * false when another owner holds a live lease; `refresh` is the heartbeat and
 * answers whether this owner still holds it; `release` frees it.
 * @typedef {Object} InboxLease
 * @property {number} [ttlMs] - How long a lease survives without a heartbeat; a drainer renews well inside it.
 * @property {(arg0: {threadId: string, owner: string, now?: number}) => Promise<boolean>} acquire
 * @property {(arg0: {threadId: string, owner: string, now?: number}) => Promise<boolean>} refresh
 * @property {(arg0: {threadId: string, owner: string}) => Promise<boolean>} release
 */

/**
 * A pending row as the store keeps it: a plain message row plus `delivery` and
 * the stable `merciId`.
 * @typedef {Record<string, unknown>} InboxRow
 */

/**
 * What a host implements to persist the inbox: `ChatSessionBuilder.withInboxStore`
 * takes any object with these four methods.
 *
 * `lease` is optional but required for correctness when more than one process
 * drains the same thread: the built-ins implement it on the scheduler's claim
 * store, so a stopped drainer's lease is reclaimed through the documented stale
 * path instead of double-delivering.
 * @typedef {Object} InboxStore
 * @property {(arg0: {threadId: string}) => Promise<Array<InboxRow>>} load
 * @property {(arg0: {threadId: string, rows: Array<InboxRow>}) => Promise<void>} save
 * @property {(arg0: {threadId: string}) => Promise<void>} clear
 * @property {(() => Promise<Array<string>>)|undefined} [list]
 * @property {InboxLease|undefined} [lease]
 */

/**
 * Rows are values, not references: a caller mutating what it read must not
 * reach into the store.
 * @param {{rows: Array<InboxRow>}} arg0
 * @returns {Array<InboxRow>}
 */
const copyRows = ({ rows }) => JSON.parse(JSON.stringify(rows));

/**
 * The file name for one thread under the store's directory. A hash keeps ids
 * that differ only by case in different files, which a case-insensitive volume
 * would otherwise collapse; the readable tail is for a human looking at `ls`.
 * @param {{threadId: string}} arg0
 * @returns {string}
 */
const fileNameFor = ({ threadId }) => {
    const hash = createHash('sha256').update(String(threadId), 'utf8').digest('hex').slice(0, 24);
    const clean = String(threadId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
    return `${hash}_${clean}.json`;
};

/**
 * @param {{threadId: unknown}} arg0
 * @returns {string}
 */
const requireThreadId = ({ threadId }) => {
    if (typeof threadId !== 'string' || threadId.trim() === '') {
        throw new ConfigurationError({ message: 'InboxStore requires a non-empty threadId.', options: { option: 'threadId' } });
    }
    return threadId;
};

/**
 * The lease key: a claim names one scheduler work item too, so the inbox
 * namespaces its own to keep the two files apart. `createFileClaimStore` hashes
 * the key, so this is identity, not a path.
 * @param {{threadId: string}} arg0
 * @returns {string}
 */
const leaseKeyFor = ({ threadId }) => `inbox:${threadId}`;

/**
 * Process-local inbox. Losing the process loses the queue — the default, and
 * what a host that already has a durable queue of its own wants.
 */
export class InMemoryInboxStore {
    /** @type {Map<string, Array<InboxRow>>} */
    #rows = new Map();
    /** The scheduler's in-process claim map: one owner per thread at a time. */
    #claims = createMemoryClaimStore();

    /** @type {InboxLease} */
    lease = {
        ttlMs: LIMITS.inbox_lease_stale_ms,
        acquire: ({ threadId, owner, now }) => this.#claims.acquire({ workItemId: leaseKeyFor({ threadId: requireThreadId({ threadId }) }), owner, now }),
        refresh: ({ threadId, owner, now }) => /** @type {any} */ (this.#claims).refresh({ workItemId: leaseKeyFor({ threadId: requireThreadId({ threadId }) }), owner, now }),
        release: ({ threadId, owner }) => this.#claims.release({ workItemId: leaseKeyFor({ threadId: requireThreadId({ threadId }) }), owner })
    };

    /**
     * @param {{threadId: string}} arg0
     * @returns {Promise<Array<InboxRow>>}
     */
    async load({ threadId }) {
        const key = requireThreadId({ threadId });
        return copyRows({ rows: this.#rows.get(key) ?? [] });
    }

    /**
     * @param {{threadId: string, rows: Array<InboxRow>}} arg0
     * @returns {Promise<void>}
     */
    async save({ threadId, rows }) {
        const key = requireThreadId({ threadId });
        if (rows.length === 0) this.#rows.delete(key);
        else this.#rows.set(key, copyRows({ rows }));
    }

    /**
     * @param {{threadId: string}} arg0
     * @returns {Promise<void>}
     */
    async clear({ threadId }) {
        this.#rows.delete(requireThreadId({ threadId }));
    }

    /** @returns {Promise<Array<string>>} the threads that still hold rows */
    async list() {
        return [...this.#rows.keys()];
    }
}

/**
 * File-backed inbox: one JSON file per thread, written atomically (tmp + rename,
 * fsync) so a crash mid-save leaves the previous queue intact. A corrupt file is
 * quarantined and reported, never silently overwritten; an unreadable one throws,
 * because treating EACCES as "empty" would let the next save destroy the queue.
 */
export class LocalFileInboxStore {
    /** @type {string} */
    #dir;
    /** @type {Promise<void>} */
    #tail = Promise.resolve();
    /** @type {import('./scheduler/claims.mjs').ClaimStore} */
    #claims;

    /**
     * @param {{dir?: string, leaseStaleMs?: number}} arg0 -
     * `leaseStaleMs` is how long a lease may go without a heartbeat before
     * another drainer may reclaim it (default `MERCI_LIMIT_INBOX_LEASE_STALE_MS`).
     */
    constructor({ dir = 'inbox', leaseStaleMs = LIMITS.inbox_lease_stale_ms } = {}) {
        this.#dir = dir;
        // The scheduler's claim store IS the lease: one `wx` file per key, a
        // dead-pid/stale reclaim, a heartbeat that never steals, and a release
        // that checks both halves of the owner token. Its measured limits apply
        // unchanged (a synchronized N>2 reclaim can double-win; the cost is a
        // duplicate dispatch, never a lost row).
        this.#claims = createFileClaimStore({ dir: join(dir, 'leases'), staleMs: leaseStaleMs });
        this.lease = {
            ttlMs: leaseStaleMs,
            acquire: ({ threadId, owner, now }) => this.#claims.acquire({ workItemId: leaseKeyFor({ threadId: requireThreadId({ threadId }) }), owner, now }),
            refresh: ({ threadId, owner, now }) => this.#claims.refresh
                ? this.#claims.refresh({ workItemId: leaseKeyFor({ threadId: requireThreadId({ threadId }) }), owner, now })
                : Promise.resolve(false),
            release: ({ threadId, owner }) => this.#claims.release({ workItemId: leaseKeyFor({ threadId: requireThreadId({ threadId }) }), owner })
        };
    }

    /** @type {InboxLease} */
    lease;

    /**
     * @param {{threadId: string}} arg0
     * @returns {string}
     */
    #file({ threadId }) {
        return join(this.#dir, fileNameFor({ threadId }));
    }

    /**
     * Serialized behind the previous write, so two saves cannot interleave a
     * rename and leave one of them applied to the other's temp file.
     * @param {() => Promise<void>} fn
     * @returns {Promise<void>}
     */
    #enqueue(fn) {
        const next = this.#tail.then(fn, fn);
        this.#tail = next.catch(() => {});
        return next;
    }

    /**
     * @param {{threadId: string}} arg0
     * @returns {Promise<Array<InboxRow>>}
     */
    async load({ threadId }) {
        const key = requireThreadId({ threadId });
        const filePath = this.#file({ threadId: key });
        const read = await readStoredJson({ filePath, version: INBOX_STORE_VERSION });
        if (read.status === 'missing') return [];
        if (read.status === 'corrupt') {
            // The queue is user data: keep the bytes for a human, start empty, and
            // say so. Failing the session would block the host on a broken file.
            const quarantine = await quarantineFile({ filePath, reason: read.kind ?? 'corrupt' });
            sdkWarn({ prefix: 'INBOX', args: [`Inbox file ${filePath} was ${read.kind ?? 'corrupt'}; moved to ${quarantine ?? '(none)'}.`] });
            return [];
        }
        const rows = /** @type {{rows?: unknown}} */ (read.value)?.rows;
        return Array.isArray(rows) ? copyRows({ rows: /** @type {Array<InboxRow>} */ (rows) }) : [];
    }

    /**
     * Writes the pending rows, or removes the file when none are left.
     * @param {{threadId: string, rows: Array<InboxRow>}} arg0
     * @returns {Promise<void>}
     */
    async save({ threadId, rows }) {
        const key = requireThreadId({ threadId });
        if (rows.length === 0) return this.clear({ threadId: key });
        await this.#enqueue(async () => {
            await writeJsonAtomic({
                filePath: this.#file({ threadId: key }),
                data: { version: INBOX_STORE_VERSION, threadId: key, rows: copyRows({ rows }), updatedAt: new Date().toISOString() }
            });
        });
    }

    /**
     * @param {{threadId: string}} arg0
     * @returns {Promise<void>}
     */
    async clear({ threadId }) {
        const key = requireThreadId({ threadId });
        await this.#enqueue(async () => {
            await fs.unlink(this.#file({ threadId: key })).catch((error) => {
                if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error;
            });
        });
    }

    /**
     * The threads a dispatcher has work for after a restart.
     * @returns {Promise<Array<string>>}
     */
    async list() {
        const names = await fs.readdir(this.#dir).catch((error) => {
            if (/** @type {any} */ (error)?.code === 'ENOENT') return [];
            throw error;
        });
        const ids = [];
        for (const name of names) {
            if (!name.endsWith('.json')) continue;
            const read = await readStoredJson({ filePath: join(this.#dir, name), version: INBOX_STORE_VERSION });
            if (read.status !== 'ok') continue;
            const stored = /** @type {{threadId?: unknown, rows?: unknown}} */ (read.value);
            if (typeof stored.threadId === 'string' && Array.isArray(stored.rows) && stored.rows.length > 0) ids.push(stored.threadId);
        }
        return ids;
    }
}
