// @ts-check


/**
 * @file SessionStore — durable conversation checkpoints.
 * @version 0.12.0
 *
 * @description
 * LangGraph-style short-term thread memory. A store persists
 * `{ messages, agentContext, sessionId? }` under a thread id so a long
 * conversation survives restarts, HITL pauses, and plan→execute handoffs
 * without re-deriving history from scratch.
 *
 * `fork()` branches a thread: the persisted checkpoint is deep-copied
 * under a NEW thread id, so the source conversation and the branch
 * continue independently from the same snapshot (LangGraph / Claude Agent
 * SDK / Google ADK branch parity). The source thread is never touched.
 *
 * `SessionStore` is the contract a store meets; `LocalFileSessionStore` (one
 * JSON file per thread) and `InMemorySessionStore` (tests, evals, short-lived
 * processes) both implement it, and a host may bring its own. Saves are
 * **last-write-wins**: two sessions saving one thread keep the later save.
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { EVENTS, emitEvent } from '../core/events.mjs';
import { ConfigurationError } from '../core/errors.mjs';
import { sdkWarn } from '../support/utils.mjs';
import { readStoredJson, writeJsonAtomic, quarantineFile } from '../support/fs-store.mjs';
import { LIMITS } from '../core/limit-config.mjs';

const SAFE_THREAD_ID_RE = /^[a-zA-Z0-9._-]+$/;


/**
 * The persisted checkpoint shape: the conversation row, the agent context,
 * the conversation id and (optionally) the execution journal.
 * @typedef {Object} SessionCheckpoint
 * @property {string} [threadId] - The caller's thread id (the file name is sanitized).
 * @property {Array<import('../messaging/unified-message.mjs').MessageRow>} [messages]
 * @property {Object} [agentContext] - The AgentContext instance (serialized as-is).
 * @property {string} [sessionId]
 * @property {string} [updatedAt]
 * @property {Object} [journal]
 */

/**
 * The checkpoint-store contract — what the session builder, the task tool and
 * the spawn registry call. `load` is **positional** (`load(threadId)`), unlike
 * the SDK's destructured convention, because third-party stores already
 * implement it that way; it may answer synchronously. A missing thread loads
 * as `null`; a failed read must throw (never `null`), or a save could replace
 * the stored conversation. Saves are last-write-wins.
 * @typedef {Object} SessionStore
 * @property {(arg0: {threadId: string, data: Record<string, unknown>}) => Promise<string|null|void>|string|null|void} save - Persists a checkpoint; may answer a location (a file path).
 * @property {(threadId: string) => Promise<SessionCheckpoint|null>|SessionCheckpoint|null} load
 * @property {(arg0: {threadId: string, newThreadId: string, overwrite?: boolean}) => Promise<SessionCheckpoint>} [fork] - Copies a thread under a new id (`forkCheckpoint` needs it).
 */

/**
 * The file name of a thread. A safe id is used verbatim, as it always was, so a
 * checkpoint written by an earlier release keeps loading; a case collision on a
 * case-insensitive volume is refused on read and on write
 * (`thread-case-collision`) instead of being avoided by re-keying the file.
 * @param {{threadId: unknown}} arg0
 */
const sanitizeId = ({ threadId }) => {
    if (threadId === null || threadId === undefined) return '';
    const raw = String(threadId);
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..') return '';
    if (SAFE_THREAD_ID_RE.test(raw)) return raw;
    const clean = raw.replace(/[^a-zA-Z0-9._-]/g, '_');
    const hash = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, LIMITS.session_hash_chars);
    return `${hash}_${clean}`;
};


/**
 * File-backed checkpoint store. One JSON file per thread; atomic writes
 * (tmp + rename) so a crash mid-save never corrupts a checkpoint. Emits
 * `session:store_*` lifecycle events when an emitter is configured.
 */
export class LocalFileSessionStore {
    #dir;
    #eventEmitter;

    
    /**
 * @param {{dir?: string, eventEmitter?: import('node:events').EventEmitter|null}} arg0
 */
        constructor({ dir = 'sessions', eventEmitter = null } = {}) {
        this.#dir = dir;
        this.#eventEmitter = eventEmitter;
    }

    
    /**
      * @param {{name: *, payload: *}} arg0
     */
        #emit({ name, payload }) {
        emitEvent({ emitter: this.#eventEmitter, name, payload });
    }

    
    /**
     * Writes a checkpoint under an already-sanitized id. Atomic (tmp +
     * rename), so a crash mid-write never corrupts a checkpoint.
     * @param {{id: string, data: Record<string, unknown>}} arg0
     * @returns {Promise<{file: string, payload: SessionCheckpoint}>} the file path and the written payload
     */
        async #write({ id, data }) {
        await fs.mkdir(this.#dir, { recursive: true });
        const file = join(this.#dir, `${id}.json`);
        const payload = { ...data, updatedAt: new Date().toISOString() };
        await writeJsonAtomic({ filePath: file, data: payload });
        return { file, payload: /** @type {SessionCheckpoint} */ (payload) };
    }

    
    /**
     * Persists a checkpoint under a thread id.
     * @param {{threadId: string, data: Record<string, unknown>}} arg0
     * @returns {Promise<string>} the checkpoint file path
     */
        async save({ threadId, data }) {
        const id = sanitizeId({ threadId });
        if (!id) throw new ConfigurationError({ message: 'SessionStore.save: invalid threadId', options: { option: 'threadId' } });
        // W2-3, write side: on a case-insensitive volume `thread-a` and
        // `Thread-A` are one file, so last-write-wins would destroy the other
        // thread's checkpoint and leave its owner with a hard error on load.
        // Only an existing file is read (a fresh save writes straight away), and
        // an unreadable one takes the same overwrite path it always did.
        if (await this.#exists({ id })) {
            /** @type {Awaited<ReturnType<typeof readStoredJson>>} */
            let existingRead;
            try {
                existingRead = await readStoredJson({ filePath: join(this.#dir, `${id}.json`) });
            } catch (error) {
                // G1-3: the same typed surface as load(); the save must not leak
                // a raw EACCES when the collision pre-read cannot open the file.
                throw this.#unreadable({ file: join(this.#dir, `${id}.json`), threadId, error, op: 'save' });
            }
            const owner = /** @type {{threadId?: unknown}|null} */ (existingRead.status === 'ok' ? existingRead.value : null)?.threadId;
            if (owner !== undefined && owner !== null && String(owner) !== String(threadId)) {
                throw new ConfigurationError({
                    message: `SessionStore.save: thread '${threadId}' would overwrite the checkpoint of '${owner}' — the two ids collide by case on a case-insensitive filesystem, and the other thread's checkpoint must not be destroyed. Rename one thread id, or give the store its own directory.`,
                    options: { option: 'thread-case-collision', nonRetryable: true }
                });
            }
        }
        // Keep the caller's thread id in the payload: the FILE name is sanitized,
        // so without this a `list()` entry cannot be mapped back to a spawn thread.
        const { file } = await this.#write({ id, data: { ...data, threadId } });
        this.#emit({ name: EVENTS.SESSION.STORE_SAVED, payload: { threadId, path: file } });
        return file;
    }

    
    /**
     * @param {string} threadId
     * @returns {Promise<SessionCheckpoint|null>} `null` only when the file is
     * absent; a present-but-corrupt record quarantines and throws, an unreadable
     * one throws without a move.
     */
        async load(threadId) {
        const id = sanitizeId({ threadId });
        if (!id) throw new ConfigurationError({ message: 'SessionStore.load: invalid threadId', options: { option: 'threadId' } });
        const file = join(this.#dir, `${id}.json`);
        /** @type {Awaited<ReturnType<typeof readStoredJson>>} */
        let read;
        try {
            read = await readStoredJson({ filePath: file });
        } catch (error) {
            // G1-3: a present record the process cannot read (EACCES/EPERM/
            // EISDIR) is an error, not a first run — `null` would replay the
            // stored effects. It is not quarantined: the rename may fail the same way.
            throw this.#unreadable({ file, threadId, error });
        }
        if (read.status === 'missing') {
            this.#emit({ name: EVENTS.SESSION.STORE_MISS, payload: { threadId } });
            return null;
        }
        if (read.status === 'corrupt') {
            throw await this.#corrupt({ file, threadId, reason: read.reason ?? 'is corrupt' });
        }
        const saved = /** @type {SessionCheckpoint} */ (read.value);
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
            throw await this.#corrupt({ file, threadId, reason: 'checkpoint is not a JSON object' });
        }
        // W2-3: a record names the thread it belongs to. On a case-insensitive
        // volume `thread-a` opens `Thread-A.json`; returning that record would be
        // a silent thread substitution, and `null` would look like a first run
        // and replay the other thread's effects. Neither is acceptable, so the
        // collision is refused by name.
        if (saved.threadId !== undefined && saved.threadId !== null && String(saved.threadId) !== String(threadId)) {
            throw new ConfigurationError({
                message: `SessionStore.load: thread '${threadId}' resolves to the checkpoint of '${saved.threadId}' — the two ids collide by case on a case-insensitive filesystem. Rename one thread id, or give the store its own directory.`,
                options: { option: 'thread-case-collision', nonRetryable: true }
            });
        }
        this.#emit({ name: EVENTS.SESSION.STORE_LOADED, payload: { threadId, messageCount: saved.messages?.length } });
        return saved;
    }

    /**
     * Quarantines a present-but-unreadable record and reports it as an error.
     * `null` would look like a first attempt and replay completed effects (G1-3);
     * `store_miss` is emitted only when the file is absent, never here.
     * @param {{file: string, threadId: string, reason: string}} arg0
     * @returns {Promise<ConfigurationError>}
     */
        async #corrupt({ file, threadId, reason }) {
        const path = await this.#quarantine({ file, threadId, reason });
        this.#emit({ name: EVENTS.SESSION.STORE_CORRUPT, payload: { threadId, reason, path } });
        return new ConfigurationError({
            message: `SessionStore.load: checkpoint for thread '${threadId}' is corrupt (${reason}); quarantined at '${path}' — a present record that cannot be restored is an error, not a missing thread.`,
            options: { option: 'checkpoint_corrupt' }
        });
    }

    
    /**
     * Reports a present record the process cannot read and refuses to resume
     * from it. Nothing is moved aside: the rename would meet the same failure,
     * and the fix is the file's permission, not its content.
     * @param {{file: string, threadId: string, error: unknown, op?: string}} arg0
     * @returns {ConfigurationError}
     */
        #unreadable({ file, threadId, error, op = 'load' }) {
        const code = String(/** @type {any} */ (error)?.code ?? 'unknown');
        const reason = `unreadable (${code})`;
        this.#emit({ name: EVENTS.SESSION.STORE_CORRUPT, payload: { threadId, reason, path: file } });
        return new ConfigurationError({
            message: `SessionStore.${op}: checkpoint for thread '${threadId}' is unreadable (${code}); the file was left in place — a present record that cannot be read is an error, not a missing thread.`,
            options: { option: 'checkpoint_unreadable' }
        });
    }

    
    /**
     * True when a checkpoint file already exists for a sanitized id.
     * @param {{id: string}} arg0
     * @returns {Promise<boolean>}
     */
        async #exists({ id }) {
        const stat = await fs.stat(join(this.#dir, `${id}.json`)).catch(() => null);
        return !!stat;
    }

    
    /**
     * Branches a thread: the source checkpoint is DEEP-COPIED (messages,
     * agent context, session id, journal) under a NEW thread id, so the
     * source and the branch continue independently from the same snapshot
     * (LangGraph / Claude Agent SDK / Google ADK branch parity). The
     * source thread is never written to.
     *
     * Throws `ConfigurationError` when the source thread is unknown or the
     * target id is already taken (pass `overwrite: true` to replace it).
     * @param {{threadId: string, newThreadId: string, overwrite?: boolean}} arg0
     * @returns {Promise<SessionCheckpoint>} the forked checkpoint
     */
        async fork({ threadId, newThreadId, overwrite = false }) {
        const sourceId = sanitizeId({ threadId });
        if (!sourceId) throw new ConfigurationError({ message: 'SessionStore.fork: invalid threadId', options: { option: 'threadId' } });
        const targetId = sanitizeId({ threadId: newThreadId });
        if (!targetId) throw new ConfigurationError({ message: 'SessionStore.fork: invalid newThreadId', options: { option: 'newThreadId' } });
        const source = await this.load(threadId);
        if (!source) throw new ConfigurationError({ message: 'SessionStore.fork: unknown threadId', options: { option: 'threadId' } });
        if (!overwrite && await this.#exists({ id: targetId })) {
            throw new ConfigurationError({ message: 'SessionStore.fork: newThreadId already exists', options: { option: 'newThreadId' } });
        }
        const cloned = structuredClone(source);
        // The clone is a different thread now.
        cloned.threadId = newThreadId;
        const { file, payload } = await this.#write({ id: targetId, data: cloned });
        this.#emit({ name: EVENTS.SESSION.STORE_FORK, payload: { threadId: newThreadId, path: file, forkedFrom: threadId } });
        return payload;
    }

    
    /**
     * Moves an unparseable checkpoint aside and warns. Quarantine failure is
     * logged, not thrown: the caller still refuses to resume from the record.
     * @param {{file: string, threadId: string, reason: string}} arg0
     * @returns {Promise<string>} the quarantine path
     */
        async #quarantine({ file, threadId, reason }) {
        return quarantineFile({ filePath: file, reason, onQuarantine: ({ path, ok, error }) => {
            if (ok) {
                sdkWarn({ prefix: 'SessionStore', args: [`Session checkpoint '${file}' (thread '${threadId}') is corrupt (${reason}); quarantined to '${path}' — refusing to resume from it.`] });
            } else {
                sdkWarn({ prefix: 'SessionStore', args: [`Session checkpoint '${file}' (thread '${threadId}') is corrupt (${reason}); quarantine failed: ${error?.message} — refusing to resume from it.`] });
            }
        } });
    }

    
    /**
     * @returns {Promise<Array<{ threadId: string, updatedAt: string }>>} sorted newest-first
     */
        async list() {
        try {
            const files = await fs.readdir(this.#dir);
            const entries = [];
            for (const f of files) {
                if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
                // The journal sibling (G1-1) is an artifact, not a thread.
                if (f.endsWith('.journal.json')) continue;
                try {
                    const raw = JSON.parse(await fs.readFile(join(this.#dir, f), 'utf8'));
                    entries.push({ threadId: raw.threadId ?? f.slice(0, -5), updatedAt: raw.updatedAt ?? '' });
                } catch {   }
            }
            return entries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        } catch {
            return [];
        }
    }
}


/**
 * A `SessionStore` in a `Map`: for tests, evals and short-lived processes. A
 * checkpoint is copied through JSON on the way in and out — the same form a
 * file store persists (an `AgentContext` keeps its `toJSON` shape) — so a
 * caller mutating what it saved or loaded never changes the stored thread.
 */
export class InMemorySessionStore {
    /** @type {Map<string, string>} */
    #threads = new Map();

    /**
     * @param {{threadId: string}} arg0
     * @returns {string}
     */
    #validId({ threadId }) {
        if (typeof threadId !== 'string' || !threadId.trim()) {
            throw new ConfigurationError({ message: 'SessionStore: invalid threadId', options: { option: 'threadId' } });
        }
        return threadId;
    }

    /**
     * Persists a checkpoint under a thread id (last write wins).
     * @param {{threadId: string, data: Record<string, unknown>}} arg0
     * @returns {Promise<null>} no location: the store has no files
     */
    async save({ threadId, data }) {
        const id = this.#validId({ threadId });
        this.#threads.set(id, JSON.stringify({ ...data, threadId, updatedAt: new Date().toISOString() }));
        return null;
    }

    /**
     * @param {string} threadId
     * @returns {Promise<SessionCheckpoint|null>} a copy, or null when the thread is unknown
     */
    async load(threadId) {
        const saved = this.#threads.get(this.#validId({ threadId }));
        return saved === undefined ? null : /** @type {SessionCheckpoint} */ (JSON.parse(saved));
    }

    /**
     * Copies a thread under a new id; the source is untouched. Throws
     * `ConfigurationError` for an unknown source or a taken target (unless `overwrite`).
     * @param {{threadId: string, newThreadId: string, overwrite?: boolean}} arg0
     * @returns {Promise<SessionCheckpoint>} the forked checkpoint
     */
    async fork({ threadId, newThreadId, overwrite = false }) {
        const source = await this.load(threadId);
        if (!source) throw new ConfigurationError({ message: 'SessionStore.fork: unknown threadId', options: { option: 'threadId' } });
        const target = this.#validId({ threadId: newThreadId });
        if (!overwrite && this.#threads.has(target)) {
            throw new ConfigurationError({ message: 'SessionStore.fork: newThreadId already exists', options: { option: 'newThreadId' } });
        }
        const forked = { ...source, threadId: target, updatedAt: new Date().toISOString() };
        this.#threads.set(target, JSON.stringify(forked));
        return /** @type {SessionCheckpoint} */ (JSON.parse(JSON.stringify(forked)));
    }
}
