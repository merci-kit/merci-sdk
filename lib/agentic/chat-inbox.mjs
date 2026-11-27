// @ts-check

/**
 * @file Chat session inbox lifecycle: drain, lease, background gate, persistence.
 * @version 0.12.0
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { EVENTS, emitEvent } from '../core/events.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { sdkWarn } from '../support/utils.mjs';
import { assertNotInFlight } from './agentic-core.mjs';
import { claimInboxTurn, interleavePendingRows, restoreInboxRows } from './pending-inbox.mjs';
import { getSpawnRegistry } from './spawn-registry.mjs';

/** @typedef {import('./chat-session-builder.mjs').ChatSessionBuilder} SessionBuilder */
/** @typedef {import('./agentic-core.mjs').LoopOptions} LoopOptions */

/**
 * @param {{session: SessionBuilder, options?: LoopOptions}} arg0
 * @returns {Promise<{answers: Array<{inboxId: string|null, text: string}>, text: string, skipped?: 'background'|'lease'}|null>}
 */
export async function drainSessionInbox({ session, options = {} }) {
    assertNotInFlight({ flag: session.isRunning(), label: 'drainInbox() cannot run while a run is in flight on this session; that run is already draining the inbox.' });
    await session.loadInbox();
    if (session.getPendingInputs().length === 0) return null;

    const gateTimeout = Number(options.backgroundTimeoutMs ?? LIMITS.inbox_background_wait_ms);
    const idle = await session.waitForBackgroundWork({ timeoutMs: options.waitForBackground === false ? 0 : gateTimeout });
    if (!idle) return { answers: [], text: '', skipped: /** @type {'background'} */ ('background') };

    const store = /** @type {any} */ (session)._inboxStore;
    const key = session._inboxKey();
    const owner = session._inboxLeaseOwner();
    const lease = store?.lease && key ? store.lease : null;
    if (lease) {
        const acquired = await lease.acquire({ threadId: key, owner });
        if (!acquired) return { answers: [], text: '', skipped: /** @type {'lease'} */ ('lease') };
    }
    const renewMs = lease
        ? Math.min(LIMITS.inbox_lease_renew_ms, Math.max(1, Math.floor(Number(lease.ttlMs ?? LIMITS.inbox_lease_stale_ms) / 3)))
        : 0;
    /** @type {ReturnType<typeof setInterval>|null} */
    let heartbeat = null;
    if (lease) {
        heartbeat = setInterval(() => {
            lease.refresh({ threadId: key, owner }).catch(() => {});
        }, renewMs);
        heartbeat.unref?.();
    }

    const budget = { left: Number(options.maxInboxTurns ?? LIMITS.max_inbox_turns) };
    const opts = { ...options, __inboxBudget: budget, __inboxTurns: /** @type {'caller'} */ ('caller') };
    /** @type {Array<{inboxId: string|null, text: string}>} */
    const answers = [];
    /** @type {'background'|'lease'|null} */
    let skipped = null;
    const onClaim = (/** @type {any} */ row) => session._emitInboxEvent({
        name: EVENTS.SESSION.INPUT_DELIVERED,
        payload: { inboxId: row?.merciId ?? null, delivery: row?.delivery ?? null }
    });
    try {
        while (true) {
            if (session.hasLiveBackgroundWork()) { skipped = 'background'; break; }
            if (lease && renewMs > 0) {
                const held = await lease.refresh({ threadId: key, owner });
                if (!held) {
                    session._emitInboxEvent({ name: EVENTS.CLIENT.WARNING, payload: {
                        code: 'INBOX_LEASE_LOST',
                        message: `The inbox lease for "${key}" was lost mid-drain; the current turn finishes and another drainer may now take the queue.`
                    } });
                }
            }
            const rows = claimInboxTurn({
                session,
                budget,
                includeBackground: true,
                onClaim,
                onExhausted: ({ pending }) => session._warnInboxExhausted({ pending })
            });
            if (rows.length === 0) break;
            const turn = interleavePendingRows({ rows: [], pending: /** @type {any} */ (rows) });
            /** @type {string} */
            let text;
            try {
                text = await session._runOnce({ initialInput: /** @type {any} */ (turn), options: opts });
            } catch (err) {
                restoreInboxRows({ session, rows });
                session._scheduleInboxPersist();
                throw err;
            }
            await session._flushInbox();
            const head = /** @type {any} */ (rows.find((row) => row?.delivery === 'queue') ?? rows[0]);
            answers.push({ inboxId: head?.merciId ?? null, text });
        }
        await session._flushInbox();
    } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (lease) await lease.release({ threadId: key, owner }).catch(() => {});
    }
    if (answers.length === 0 && skipped === null) return null;
    return {
        answers,
        text: answers.length > 0 ? answers[answers.length - 1].text : '',
        ...(skipped ? { skipped } : {})
    };
}

/** @param {{session: SessionBuilder}} arg0 */
export function hasLiveSessionBackgroundWork({ session }) {
    const self = /** @type {any} */ (session);
    if (!self.client) return false;
    const registry = getSpawnRegistry({ client: self.client });
    const background = /** @type {Map<string, Promise<unknown>>|undefined} */ (registry?.background);
    if (!(background instanceof Map) || background.size === 0) return false;
    const sessionId = session.sessionId ?? null;
    for (const record of /** @type {Map<string, any>} */ (registry?.spawns ?? new Map()).values()) {
        if (!record?.taskId || !background.has(record.taskId)) continue;
        if (record.parent === self) return true;
        const parentSessionId = record.parent?.sessionId ?? null;
        if (parentSessionId && sessionId && parentSessionId === sessionId) return true;
    }
    return false;
}

/**
 * @param {{session: SessionBuilder, timeoutMs?: number, recheckMs?: number}} arg0
 * @returns {Promise<boolean>}
 */
export async function waitForSessionBackgroundWork({ session, timeoutMs = LIMITS.inbox_background_wait_ms, recheckMs = LIMITS.inbox_background_recheck_ms }) {
    if (!session.hasLiveBackgroundWork()) return true;
    if (!(timeoutMs > 0)) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const wait = Math.max(1, Math.min(recheckMs, deadline - Date.now()));
        await new Promise((resolve) => setTimeout(resolve, wait));
        if (!session.hasLiveBackgroundWork()) return true;
    }
    return false;
}

/** @returns {string} */
export function createInboxLeaseOwner() {
    return `${hostname()}:${process.pid}:${randomUUID()}`;
}

/** @param {{session: SessionBuilder, name: string, payload: Record<string, unknown>}} arg0 */
export function emitSessionInboxEvent({ session, name, payload }) {
    emitEvent({ emitter: session.eventEmitter ?? null, name, payload, runContext: session._sessionRunCtx ?? null });
}

/** @param {{session: SessionBuilder}} arg0 @returns {string|null} */
export function sessionInboxKey({ session }) {
    const self = /** @type {any} */ (session);
    const key = self._inboxThreadId ?? self._threadId ?? session.sessionId ?? null;
    return typeof key === 'string' && key !== '' ? key : null;
}

/** @param {{session: SessionBuilder}} arg0 @returns {Promise<Array<Object>>} */
export async function loadSessionInbox({ session }) {
    const self = /** @type {any} */ (session);
    if (!self._inboxStore) return session.getPendingInputs();
    if (self._inboxLoaded === true) {
        await session._flushInbox();
        return session.getPendingInputs();
    }
    if (self._inboxLoadPromise) {
        await self._inboxLoadPromise;
        return session.getPendingInputs();
    }
    const key = session._inboxKey();
    if (!key) return session.getPendingInputs();
    self._inboxLoadPromise = (async () => {
        const stored = await self._inboxStore.load({ threadId: key });
        self._inboxLoaded = true;
        if (Array.isArray(stored) && stored.length > 0) {
            const current = session.getPendingInputs();
            const known = new Set(current.map((/** @type {any} */ row) => row?.merciId));
            const older = stored.filter((/** @type {any} */ row) => !known.has(row?.merciId));
            if (older.length > 0) self._pendingInputRows = [...older, ...current];
        }
    })();
    try {
        await self._inboxLoadPromise;
    } finally {
        self._inboxLoadPromise = null;
    }
    await session._flushInbox();
    return session.getPendingInputs();
}

/** @param {{session: SessionBuilder}} arg0 */
export function scheduleSessionInboxPersist({ session }) {
    const self = /** @type {any} */ (session);
    if (!self._inboxStore || self._inboxLoaded !== true) return;
    const key = session._inboxKey();
    if (!key) return;
    const rows = session.getPendingInputs();
    self._inboxSaveTail = (self._inboxSaveTail ?? Promise.resolve())
        .then(() => self._inboxStore.save({ threadId: key, rows }))
        .catch((/** @type {any} */ err) => {
            sdkWarn({ prefix: 'INBOX', args: [`Inbox save failed for "${key}": ${err?.message ?? String(err)}`] });
        });
}

/** @param {{session: SessionBuilder}} arg0 @returns {Promise<void>} */
export async function flushSessionInbox({ session }) {
    const self = /** @type {any} */ (session);
    if (!self._inboxStore) return;
    session._scheduleInboxPersist();
    await (self._inboxSaveTail ?? Promise.resolve());
}
