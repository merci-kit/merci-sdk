// @ts-check
/**
 * @file Memory providers + block renderers.
 * @version 0.12.0
 *
 * @description
 * The storage tier: MemoryProvider (base contract), LocalFileMemoryProvider
 * (JSON-file bank with an optional vector/embedding tier) and
 * CompositeMemoryProvider (fan-out across named banks). Also exports the two
 * renderers (formatFactBullets / buildMemoryBlock) shared by the manager and
 * the component engine.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    DEFAULT_MEMORY_FILE_PATH,
    DEFAULT_MEMORY_SQLITE_PATH,
    DEFAULT_UTF8_ENCODING,
    LOG_PREFIX_MEMORY,
    DEFAULT_MEMORY_CATEGORY,
    MEMORY_FACT_ID_PREFIX,
    DEFAULT_MEMORY_BANK_NAME,
    DEFAULT_MEMORY_BANK_DESC,
    COMPOSITE_MEMORY_BANK_NAME,
    COMPOSITE_MEMORY_BANK_DESC,
    FS_ENOENT_CODE
} from '../../core/constants/index.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { sdkLog, sdkWarn, truncateForPrompt, cosineSimilarity, isProcessAlive } from '../../support/utils.mjs';
import { ConfigurationError, isAbortError } from '../../core/errors.mjs';
import { COGNITIVE_MEMORY_PROMPTS } from '../../core/prompts.mjs';
import { validateStrict } from '../../support/json.mjs';
import { readStoredJson, writeJsonAtomic, quarantineFile } from '../../support/fs-store.mjs';
import { sleepAbortable } from '../../support/retry-policy.mjs';

const MEMORY_BANK_SCHEMA = {
    type: 'object',
    properties: {
        facts: { type: 'array' },
        lastSyncedTurnIndex: { type: 'number' },
        history: { type: 'array' }
    }
};

const MEMORY_BANK_VERSION = 1;

/**
 * One stored fact.
 * @typedef {Object} MemoryFact
 * @property {string} id
 * @property {string} content
 * @property {string} [category]
 * @property {number} [timestamp]
 * @property {Array<number>} [embedding]
 * @property {number} [dimension]
 * @property {string|null} [sessionKey]
 * @property {number} [score] - Ranking weight added by query().
 */

/**
 * Per-call store options a manager passes through.
 * @typedef {Object} MemoryStoreOptions
 * @property {string|null} [sessionKey]
 * @property {boolean} [deferSave] - Skip the per-call save; the caller writes once
 *   after a batch (a distill of N facts must not rewrite the bank N times).
 */

/**
 * A provider the composite fan-out drives. Structural: a duck-typed provider is
 * legal (the manager's contract is the five methods), and the persistence hooks
 * are whatever the provider does.
 * @typedef {Object} CompositeProvider
 * @property {string} name
 * @property {string} [description]
 * @property {Function} load
 * @property {Function} save
 * @property {Function} query
 * @property {Function} store
 * @property {Function} delete
 * @property {Function} clear
 * @property {Function} [getBankDescriptions]
 * @property {number} [lastSyncedTurnIndex]
 * @property {number} [restoredSyncIndex]
 */

/**
 * Options accepted by `new LocalFileMemoryProvider(...)`.
 * @typedef {Object} LocalFileMemoryProviderOptions
 * @property {string} [filePath]
 * @property {string} [name]
 * @property {string} [description]
 * @property {Function|null} [embedder]
 * @property {Function|null} [reranker] - Opt-in `({ text, facts }) => Promise<Array<MemoryFact>>`, reorders the top candidates only.
 */


/** @param {{embedder: *, text: *}} arg0 */
async function safeEmbed({ embedder, text }) {
    try {
        return await ( (embedder))(text);
    } catch (err) {
        if (isAbortError({ err })) throw err;
        return null;
    }
}


/**
 * @param {{value: unknown}} arg0 -
 * @returns {string}
 */
export function escapePromptField({ value }) {
    return String(value ?? '').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}


/**
 * distillation history. CR/LF in every field are escaped.
 * @param {{facts: Array<MemoryFact>, bank?: string|null}} arg0 - [{ id, content, ... }].
 * @returns {string}
 */
export function formatFactBullets({ facts, bank = null }) {
    let block = '';
    for (const fact of facts) {
        block += `* [id: ${escapePromptField({ value: fact.id })}]${bank ? ` [bank: ${escapePromptField({ value: bank })}]` : ''} ${escapePromptField({ value: fact.content })}\n`;
    }
    return block;
}


/**
 * unsynced-turns lag warning + footer.
 * @param {{facts: Array<MemoryFact>, gap?: number, lastSync?: number, currentCount?: number}} arg0 -
 * @returns {string}
 */
export function buildMemoryBlock({ facts, gap = 0, lastSync = 0, currentCount = 0 }) {
    const prompts =  (COGNITIVE_MEMORY_PROMPTS);
    let block = prompts.MEMORY_BLOCK_HEADER + formatFactBullets({ facts });
    if (gap > 0) block += prompts.MEMORY_LAG_WARNING({ gap, lastSync, currentCount });
    block += prompts.MEMORY_BLOCK_FOOTER;
    return block;
}

const MANAGER_PROVIDER_METHODS = ['load', 'save', 'query', 'store', 'getBankDescriptions'];
export const ENGINE_PROVIDER_METHODS = ['query', 'store'];


/**
 * methods. `requiredMethods` defaults to the full MemoryManager contract.
 * @param {{provider: Object, owner: string, requiredMethods?: Array<string>}} arg0 -
 */
export function assertProvider({ provider, owner, requiredMethods = MANAGER_PROVIDER_METHODS }) {
    if (provider instanceof MemoryProvider) return;
    const candidate = /** @type {Record<string, unknown>} */ (provider);
    const missing = requiredMethods.filter(m => typeof candidate?.[m] !== 'function');
    if (missing.length > 0) {
        throw new ConfigurationError({ message: `${owner} requires a MemoryProvider or a duck-typed provider implementing: ${missing.join(', ')}.`, options: { option: 'provider' } });
    }
}


/**
 * Base memory provider contract. Subclasses override the persistence + query
 * behavior; the vector tier (`embed`) is optional and degrades to lexical/recency.
 */
export class MemoryProvider {
    /**
     * @param {Object} [options]
     * @param {string} [options.filePath] - JSON bank path.
     * @param {string} [options.name] - Bank name.
     * @param {string} [options.description]
     * @param {Function} [options.embedder] - Provider-level embedder.
     */
        constructor() {
        this.name = DEFAULT_MEMORY_BANK_NAME;
        this.description = DEFAULT_MEMORY_BANK_DESC;
    }

    
    /**
     * Human-readable bank roster (name: description lines).
     * @returns {string}
     */
        getBankDescriptions() {
        return `- "${this.name}": ${this.description}\n`;
    }

    
    /**
     * Loads the provider's facts from persistence.
     * @returns {Promise<void>}
     */
        async load() {}
    
    /**
     * Persists the current facts (throws on write failure).
     * @returns {Promise<void>}
     */
        async save() {}
    
    /**
     * @param {{text: string, limit?: number, embedder?: Function|null}} arg0 -
     * @returns {Promise<Array<MemoryFact>>} facts, optionally with a `.score`.
     */
        async query({ text, limit, embedder = null }) { return []; }
    
    /**
     * @param {{content: string, category?: string, targetBanks?: Array<string>, embedder?: Function|null, opts?: MemoryStoreOptions}} arg0 -
     * @returns {Promise<MemoryFact|null>} the stored fact, or null on failure.
     */
        async store({ content, category, targetBanks, embedder, opts }) { return null; }
    
    /**
     * @param {{id: string}} arg0 -
     * @returns {Promise<boolean>} whether anything was deleted.
     */
        async delete({ id }) { return false; }
    
    /**
     * Clears all facts.
     * @returns {Promise<void>}
     */
        async clear() {}
    
    /**
     * Embeds text (optional vector tier).
     * @param {string} text
     * @returns {Promise<Array<number>|null>}
     */
        async embed(text) { return null; }

    
    /** Legacy persisted sync checkpoint (0 when unset). */
        get lastSyncedTurnIndex() { return 0; }
    
    /** Legacy persisted sync checkpoint setter (no-op on the base class). */
        set lastSyncedTurnIndex(val) {}

    
    /** Persisted cursor as restored by load() (0 when unset/unsupported). */
        get restoredSyncIndex() { return 0; }
}


/**
 * File-backed memory bank: one JSON file of facts with atomic saves. Query is
 * vector-first (optional embedder, cosine-ranked) then lexical token overlap,
 * then recency. Facts cap at LIMITS.memory_max_facts_per_bank (oldest evicted).
 * @extends {MemoryProvider}
 */
export class LocalFileMemoryProvider extends MemoryProvider {
    
    /**
      * @param {{options?: LocalFileMemoryProviderOptions}} arg0
     */
        constructor({ options = {} } = {}) {
        super();
        this.filePath = /** @type {string} */ (options.filePath || DEFAULT_MEMORY_FILE_PATH);
        this.name = /** @type {string} */ (options.name || DEFAULT_MEMORY_BANK_NAME);
        this.description = /** @type {string} */ (options.description || DEFAULT_MEMORY_BANK_DESC);
        
        /** @type {Array<MemoryFact>} */
                this.facts = [];
        this.embedder = /** @type {Function|null} */ (options.embedder || null);
        this.reranker = typeof options.reranker === 'function' ? options.reranker : null;
        this._lastSyncedTurnIndex = 0;
        this._loadedSyncIndex = 0;
        this._loaded = false;
        this._loadPromise = null;
        this._deletedIds = /** @type {Set<string>} */ (new Set());
        this._cleared = false;
        this.#saveChain = Promise.resolve();
        this._embedFailedIds = /** @type {Set<string>} */ (new Set());
        /**
         * The bank's audit trail (B3): one bounded row per add / rewrite / forget,
         * with the value before and after and who did it. The artifact manifest
         * (`artifacts.mjs`) is the prior art for this shape.
         * @type {Array<{event: 'add'|'update'|'delete'|'clear'|'evict', id: string, old: string|null, new: string|null, actor: string|null, ts: number}>}
         */
        this._history = [];
    }

    #saveChain;

    
    /** Persisted sync checkpoint (turn index). */
        get lastSyncedTurnIndex() {
        return this._lastSyncedTurnIndex;
    }

    
    /** Persisted sync checkpoint setter. */
        set lastSyncedTurnIndex(val) {
        this._lastSyncedTurnIndex = val;
    }

    
    /** Cursor restored from disk by load() — the manager's restart seed. */
        get restoredSyncIndex() {
        return this._loadedSyncIndex;
    }

    /**
     * The bank's audit trail, oldest first: what was added, rewritten or forgotten,
     * with the value on both sides and the session that did it.
     * @returns {Array<{event: string, id: string, old: string|null, new: string|null, actor: string|null, ts: number}>}
     */
        get history() {
        return this._history.map((row) => ({ ...row }));
    }

    /**
     * Appends one audit row, bounded to LIMITS.memory_max_history_rows.
     * @param {{event: 'add'|'update'|'delete'|'clear'|'evict', id: string, oldValue?: string|null, newValue?: string|null, actor?: string|null}} arg0
     */
        #appendHistory({ event, id, oldValue = null, newValue = null, actor = null }) {
        this._history.push({
            event,
            id,
            old: oldValue === null || oldValue === undefined ? null : String(oldValue),
            new: newValue === null || newValue === undefined ? null : String(newValue),
            actor: typeof actor === 'string' && actor.trim() ? actor : null,
            ts: Date.now(),
        });
        if (this._history.length > LIMITS.memory_max_history_rows) {
            this._history = this._history.slice(-LIMITS.memory_max_history_rows);
        }
    }

    
    /**
     * Loads facts + checkpoint from disk (idempotent; a missing file starts
     * fresh). A corrupt or version-mismatched bank is quarantined and the
     * provider starts empty.
     * @returns {Promise<void>}
     */
        async load() {
        if (this._loaded) return;
        if (this._loadPromise) return this._loadPromise;
        this._loadPromise = this.#loadNow().finally(() => {
            this._loadPromise = null;
        });
        return this._loadPromise;
    }

    async #loadNow() {
        if (this._loaded) return;
        const read = await readStoredJson({ filePath: this.filePath, schema: MEMORY_BANK_SCHEMA, version: MEMORY_BANK_VERSION });
        if (read.status === 'missing') {
            this.facts = [];
            this._lastSyncedTurnIndex = 0;
            this._loadedSyncIndex = 0;
            this._loaded = true;
            sdkLog({ prefix: LOG_PREFIX_MEMORY, args: [`No existing memory file found for bank '${this.name}'. Starting fresh at ${this.filePath}`] });
            return;
        }
        if (read.status === 'corrupt') {
            await this.#quarantine(read.kind === 'version'
                ? `has unsupported version ${read.reason}`
                : `is corrupt (${read.reason})`);
            this.facts = [];
            this._lastSyncedTurnIndex = 0;
            this._loadedSyncIndex = 0;
            this._loaded = true;
            return;
        }
        const data = read.value;
        this._history = Array.isArray(data.history) ? data.history.slice(-LIMITS.memory_max_history_rows) : [];
        this._deletedIds = new Set(this.#readTombstones({ data }));
        this.facts = (/** @type {Array<MemoryFact>} */ (Array.isArray(data.facts) ? data.facts : []))
            .filter(f => !(f && f.id !== undefined && this._deletedIds.has(f.id)));
        this._lastSyncedTurnIndex = typeof data.lastSyncedTurnIndex === 'number' ? data.lastSyncedTurnIndex : 0;
        this._loadedSyncIndex = this._lastSyncedTurnIndex;
        this._loaded = true;
        sdkLog({ prefix: LOG_PREFIX_MEMORY, args: [`Loaded ${this.facts.length} facts from bank '${this.name}' (${this.filePath})`] });
    }

    
    /**
     * Moves a corrupt bank aside and warns. Quarantine failure is logged, not
     * thrown: the caller still starts empty rather than failing the memory tier.
     * @param {string} reason
     * @returns {Promise<void>}
     */
        async #quarantine(reason) {
        await quarantineFile({ filePath: this.filePath, reason, onQuarantine: ({ path, ok, error }) => {
            if (ok) {
                sdkWarn({ prefix: LOG_PREFIX_MEMORY, args: [`Memory bank '${this.filePath}' ${reason}; quarantined to '${path}' — starting empty.`] });
            } else {
                sdkWarn({ prefix: LOG_PREFIX_MEMORY, args: [`Memory bank '${this.filePath}' ${reason}; quarantine failed: ${error?.message} — starting empty.`] });
            }
        } });
    }

    
    /**
     * Deletion tombstones carried by a persisted bank payload.
     * @param {{data: *}} arg0
     * @returns {Array<string>}
     */
        #readTombstones({ data }) {
        return Array.isArray(data?.deletedIds) ? data.deletedIds.filter((/** @type {*} */ id) => typeof id === 'string') : [];
    }

    
    /**
     * Most-recent tombstones, capped so a long-lived bank cannot grow without
     * bound.
     * ponytail: cap of LIMITS.memory_max_facts_per_bank; an evicted tombstone could
     * only be resurrected by a writer stale by that many deletions.
     * @returns {Array<string>}
     */
        #boundedTombstones() {
        return Array.from(this._deletedIds).slice(-LIMITS.memory_max_facts_per_bank);
    }

    
    /**
     * Persists facts + checkpoint atomically (tmp file + rename). Throws on
     * write failure — the manager only advances its checkpoint after success.
     * Saves are serialized per instance.
     * @returns {Promise<void>}
     */
        save() {
        const task = this.#saveChain.then(() => this.#saveNow(), () => this.#saveNow());
        this.#saveChain = task.then(() => {}, () => {});
        return task;
    }

    
    /**
     * Runs `fn` under an exclusive lock on the bank file. Two providers on the
     * same file would otherwise each read, merge and write concurrently, and
     * the slower writer's merge is lost (B5). The lock is a sibling `wx` file
     * holding the owner's pid, so it is exclusive across processes — on one
     * machine: the pid liveness check assumes a shared pid namespace, so a
     * bank on a network filesystem or across containers is not protected by
     * it.
     * ponytail: pid ownership, no mtime heuristic — a LIVE holder is never
     * displaced (an mtime rule would steal the lock from a slow writer), a dead
     * one is reclaimed at once. The reclaim itself is exclusive: a second
     * `wx` file elects one reclaimer, so two of them cannot both delete the
     * dead lock and both write.
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async #runExclusive(fn) {
        const lockPath = `${this.filePath}.lock`;
        const claimPath = `${lockPath}.reclaim`;
        const lockTimeoutMs = LIMITS.memory_lock_timeout_ms;
        const deadline = Date.now() + lockTimeoutMs;
        const token = `${process.pid}:${randomUUID()}`;
        await fs.mkdir(dirname(lockPath), { recursive: true });
        for (;;) {
            try {
                await fs.writeFile(lockPath, token, { encoding: DEFAULT_UTF8_ENCODING, flag: 'wx' });
                break;
            } catch (err) {
                if (/** @type {any} */ (err)?.code !== 'EEXIST') throw err;
                // Reclaim BEFORE the deadline: a lock left by a dead writer is
                // taken over, not waited out.
                if (await this.#reclaimIfDead({ lockPath, claimPath, token })) break;
                if (Date.now() > deadline) {
                    throw new ConfigurationError({
                        message: `Memory bank '${this.filePath}' is locked by another writer; gave up after ${lockTimeoutMs}ms.`,
                        options: { option: 'filePath' },
                    });
                }
                await sleepAbortable({ ms: LIMITS.memory_lock_retry_ms });
            }
        }
        try {
            return await fn();
        } finally {
            // Release only the lock we still own.
            const state = await this.#lockState({ lockPath });
            if (state?.token === token) await fs.unlink(lockPath).catch(() => {});
        }
    }

    /**
     * Takes over a lock whose owner is gone. Only ONE reclaimer acts at a
     * time — without that, two reclaimers both delete the dead lock and both
     * enter the critical section, and one writer's facts are lost.
     * @param {{lockPath: string, claimPath: string, token: string}} arg0
     * @returns {Promise<boolean>} true when we now hold the lock
     */
    async #reclaimIfDead({ lockPath, claimPath, token }) {
        // ONE decision point, under the claim: the owner must be gone. (A
        // pre-check outside the claim would make this second check reachable
        // only in a narrow race, and untestable.)
        try {
            await fs.writeFile(claimPath, token, { encoding: DEFAULT_UTF8_ENCODING, flag: 'wx' });
        } catch (err) {
            if (/** @type {any} */ (err)?.code !== 'EEXIST') throw err;
            // Another reclaimer is on it — take the claim over only if it died.
            const claim = await this.#lockState({ lockPath: claimPath });
            if (claim && claim.pid !== null && !isProcessAlive({ pid: claim.pid })) {
                await fs.unlink(claimPath).catch(() => {});
            }
            return false;
        }
        try {
            const current = await this.#lockState({ lockPath });
            if (!current || !this.#isAbandoned({ state: current })) return false;
            await fs.unlink(lockPath).catch(() => {});
            // Our lock now — a fresh writer may win the gap, and then we wait.
            try {
                await fs.writeFile(lockPath, token, { encoding: DEFAULT_UTF8_ENCODING, flag: 'wx' });
                return true;
            } catch (err) {
                if (/** @type {any} */ (err)?.code !== 'EEXIST') throw err;
                return false;
            }
        } finally {
            await fs.unlink(claimPath).catch(() => {});
        }
    }

    /**
     * A lock is abandoned when its owner process is gone. A lock whose content
     * carries no pid cannot be owned — it is reclaimed once it is old enough
     * that no writer could still be creating it.
     * @param {{state: {pid: number|null, ageMs: number}}} arg0
     * @returns {boolean}
     */
    #isAbandoned({ state }) {
        if (state.pid !== null) return !isProcessAlive({ pid: state.pid });
        return state.ageMs > LIMITS.memory_lock_stale_ms;
    }

    /**
     * The owner of a lock file: its pid, its raw token and its age. A
     * non-regular file (a FIFO, a directory) is never read — reading it could
     * block forever, and it cannot be a lock we wrote.
     * @param {{lockPath: string}} arg0
     * @returns {Promise<{pid: number|null, token: string|null, ageMs: number}|null>}
     */
    async #lockState({ lockPath }) {
        const stat = await fs.stat(lockPath).catch(() => null);
        if (!stat) return null;
        const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
        if (!stat.isFile()) return { pid: null, token: null, ageMs };
        const raw = await fs.readFile(lockPath, DEFAULT_UTF8_ENCODING).catch(() => null);
        if (raw === null) return { pid: null, token: null, ageMs };
        const token = String(raw);
        const pid = Number.parseInt(token.split(':')[0], 10);
        return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, token, ageMs };
    }

    /**
     * @returns {Promise<void>}
     */
        async #saveNow() {
        await this.#runExclusive(() => this.#saveLocked());
    }

    /**
     * The read-merge-write of the bank. Runs under the file lock.
     * @returns {Promise<void>}
     */
        async #saveLocked() {
        if (!this._cleared) {
            try {
                const raw = await fs.readFile(this.filePath, DEFAULT_UTF8_ENCODING);
                const parsed = validateStrict({ input: raw, schema: MEMORY_BANK_SCHEMA });
                const parsedData = parsed.success && parsed.data && typeof parsed.data === 'object'
                    ? /** @type {Record<string, unknown>} */ (parsed.data)
                    : null;
                if (parsedData && Array.isArray(parsedData.facts)) {
                    // ponytail: this reconciles a *stale* second writer on its next
                    for (const id of this.#readTombstones({ data: parsedData })) this._deletedIds.add(id);
                    if (this._deletedIds.size > 0) {
                        this.facts = this.facts.filter(f => !this._deletedIds.has(f.id));
                    }
                    const known = new Set(this.facts.map(f => f.id));
                    for (const f of parsedData.facts) {
                        if (f && f.id !== undefined && !known.has(f.id) && !this._deletedIds.has(f.id)) {
                            known.add(f.id);
                            this.facts.push(f);
                        }
                    }
                    if (this.facts.length > LIMITS.memory_max_facts_per_bank) {
                        this.facts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                        this.facts.length = LIMITS.memory_max_facts_per_bank;
                    }
                    // Merge the other writer's audit rows into ours (oldest first, by ts
                    // then insertion) so a concurrent writer's edit is not lost (B3/B5).
                    const diskHistory = Array.isArray(parsedData.history) ? parsedData.history : [];
                    if (diskHistory.length > 0) {
                        const seen = new Set(this._history.map((row) => `${row.ts}|${row.event}|${row.id}|${row.new ?? ''}`));
                        const merged = [...this._history, ...diskHistory.filter((/** @type {any} */ row) => !seen.has(`${row.ts}|${row.event}|${row.id}|${row.new ?? ''}`))]
                            .sort((a, b) => (a.ts || 0) - (b.ts || 0));
                        this._history = merged.slice(-LIMITS.memory_max_history_rows);
                    }
                }
            } catch (error) {
                // A missing file is the first write; any other read failure
                // (EACCES, EIO, …) must NOT fall through to the overwrite: that
                // would silently discard the facts another writer stored.
                if (/** @type {any} */ (error)?.code !== FS_ENOENT_CODE) throw error;
            }
        }
        /** @type {Record<string, any>} */
        const data = {
            version: MEMORY_BANK_VERSION,
            facts: this.facts,
            lastSyncedTurnIndex: this._lastSyncedTurnIndex
        };
        const tombstones = this.#boundedTombstones();
        if (tombstones.length > 0) data.deletedIds = tombstones;
        if (this._history.length > 0) data.history = this._history.slice(-LIMITS.memory_max_history_rows);
        await writeJsonAtomic({ filePath: this.filePath, data });
        this._cleared = false;
        sdkLog({ prefix: LOG_PREFIX_MEMORY, args: [`Saved ${this.facts.length} facts to bank '${this.name}' (${this.filePath})`] });
    }

    
    /**
     * lexical token-overlap, then recency. Returns up to `limit` facts.
     * @param {{text: string, limit?: number, embedder?: Function|null}} arg0 -
     * @returns {Promise<Array<MemoryFact>>} facts, each with a `.score` when ranked.
     */
        async query({ text, limit = LIMITS.memory_query_limit, embedder = null }) {
        await this.load();
        if (!this.facts || this.facts.length === 0) return [];
        if (limit <= 0) return [];

        const scored = this.facts.map(fact => ({ fact, score: 0 }));

        const useEmbedder = embedder || this.embedder;
        if (useEmbedder && text && typeof text === 'string') {
            await this._backfillEmbeddings({ embedder: useEmbedder });
            const qv = await safeEmbed({ embedder: useEmbedder, text });
            if (Array.isArray(qv) && qv.length > 0) {
                for (const item of scored) {
                    if (!Array.isArray(item.fact.embedding) || item.fact.embedding.length !== qv.length) continue;
                    const sim = cosineSimilarity({ a: item.fact.embedding, b: qv });
                    if (sim > 0) item.score += sim;
                }
            }
        }

        if (text && typeof text === 'string') {
            const queryTokens = text.toLowerCase().split(/\s+/).filter(t => t.length >= LIMITS.memory_query_min_token_length);
            if (queryTokens.length > 0) {
                for (const item of scored) {
                    const factText = String(item.fact.content || '').toLowerCase();
                    let overlap = 0;
                    for (const token of queryTokens) {
                        if (factText.includes(token)) overlap++;
                    }
                    if (overlap > 0) item.score += overlap / queryTokens.length;
                }
            }
        }

        const ranked = scored
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
        let candidates = ranked;
        if (this.reranker && ranked.length > 1) {
            try {
                const reranked = await this.reranker({ text, facts: ranked.map(item => item.fact) });
                if (Array.isArray(reranked)) {
                    const byFact = new Map(ranked.map(item => [item.fact, item]));
                    /** @type {Array<{fact: MemoryFact, score: number}>} */
                    const kept = [];
                    for (const fact of reranked) {
                        const item = byFact.get(fact);
                        if (item && !kept.includes(item)) kept.push(item);
                    }
                    // A reranker may reorder, never add or drop: a partial list keeps the original.
                    if (kept.length === ranked.length) candidates = kept;
                }
            } catch {
                // A failed reranker degrades to the original order; the query still answers.
            }
        }
        const results = candidates.map(item => ({ ...item.fact, score: item.score }));
        if (results.length > 0) return results;

        return [...this.facts]
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(0, limit);
    }

    
    /**
     * timestamp), optionally embedding it, and persists the bank.
     * @param {{content: string, category?: string, targetBanks?: Array<string>, embedder?: Function|null, opts?: MemoryStoreOptions}} arg0 -
     *   facts dedupe only against the SAME session's facts. Direct callers keep
     *   the global content dedupe.
     * @returns {Promise<MemoryFact|null>} the stored/refreshed fact.
     */
        async store({ content, category = DEFAULT_MEMORY_CATEGORY, targetBanks = [], embedder = null, opts = {} }) {
        await this.load();
        if (!content || typeof content !== 'string') return null;

        const cleanContent = truncateForPrompt({ text: content.trim(), maxChars: LIMITS.memory_fact_max_chars });
        const sessionKey = typeof opts?.sessionKey === 'string' ? opts.sessionKey : null;
        const existing = this.facts.find(f =>
            String(f.content || '').trim().toLowerCase() === cleanContent.toLowerCase()
            && (sessionKey === null || f.sessionKey === sessionKey));
        if (existing) {
            existing.timestamp = Date.now();
            this.#appendHistory({ event: 'update', id: String(existing.id), oldValue: existing.content, newValue: cleanContent, actor: sessionKey });
            if (!opts?.deferSave) await this.save();
            return existing;
        }

        const fact =  ({
            id: `${MEMORY_FACT_ID_PREFIX}${this.name}_${randomUUID()}`,
            content: cleanContent,
            category: String(category ?? '').trim(),
            timestamp: Date.now()
        });
        if (sessionKey !== null) /** @type {any} */ (fact).sessionKey = sessionKey;
        const useEmbedder = embedder || this.embedder;
        if (useEmbedder) {
            const emb = await safeEmbed({ embedder: useEmbedder, text: cleanContent });
            if (Array.isArray(emb) && emb.length > 0) {
                /** @type {any} */ (fact).embedding = emb;
                /** @type {any} */ (fact).dimension = emb.length;
            }
        }
        this.facts.push(fact);
        this.#appendHistory({ event: 'add', id: String(fact.id), newValue: cleanContent, actor: sessionKey });
        if (this.facts.length > LIMITS.memory_max_facts_per_bank) {
            this.facts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            const evicted = this.facts.splice(LIMITS.memory_max_facts_per_bank);
            // An evicted fact is a fact the bank forgot; the trail says so (B3).
            for (const gone of evicted) {
                this.#appendHistory({ event: 'evict', id: String(gone?.id ?? ''), oldValue: typeof gone?.content === 'string' ? gone.content : null, actor: sessionKey });
            }
        }
        if (!opts?.deferSave) await this.save();
        return fact;
    }

    
    /**
     * @param {{id: string, opts?: MemoryStoreOptions}} arg0 -
     * @returns {Promise<boolean>}
     */
        async delete({ id, opts = {} }) {
        await this.load();
        const initialLen = this.facts.length;
        const removed = this.facts.find(f => f.id === id);
        this.facts = this.facts.filter(f => f.id !== id);
        const changed = this.facts.length !== initialLen;
        if (changed) {
            this._deletedIds.add(id);
            this.#appendHistory({
                event: 'delete',
                id: String(id),
                oldValue: typeof removed?.content === 'string' ? removed.content : null,
                actor: typeof opts?.sessionKey === 'string' ? opts.sessionKey : null,
            });
            if (!opts?.deferSave) await this.save();
        }
        return changed;
    }

    
    /**
     * Empties the bank and resets the checkpoint.
     * @param {{opts?: {sessionKey?: string}}} [arg0] - `sessionKey` is recorded as the
     *   actor on the trail rows, like `delete`.
     * @returns {Promise<void>}
     */
        async clear({ opts = /** @type {{sessionKey?: string}} */ ({}) } = {}) {
        await this.load();
        const forgotten = this.facts.filter((f) => f && f.id !== undefined);
        for (const f of forgotten) {
            this._deletedIds.add(f.id);
            this.#appendHistory({
                event: 'clear',
                id: String(f.id),
                oldValue: typeof f.content === 'string' ? f.content : null,
                actor: typeof opts?.sessionKey === 'string' ? opts.sessionKey : null,
            });
        }
        // A clear larger than the trail bound would lose the tail of what it forgot;
        // one summary row (written last, so the cap keeps it) names the size.
        if (forgotten.length > LIMITS.memory_max_history_rows) {
            this.#appendHistory({ event: 'clear', id: '*', newValue: `${forgotten.length} facts`, actor: typeof opts?.sessionKey === 'string' ? opts.sessionKey : null });
        }
        this.facts = [];
        this._lastSyncedTurnIndex = 0;
        this._cleared = true;
        await this.save();
    }

    
    /**
      * @param {{embedder?: Function|null}} arg0
     */
        async _backfillEmbeddings({ embedder = null } = {}) {
        const useEmbedder = embedder || this.embedder;
        if (!useEmbedder) return;
        const missing = this.facts.filter(f => !Array.isArray(f.embedding) && !this._embedFailedIds.has(f.id));
        if (missing.length === 0) return;
        let changed = false;
        const BATCH = LIMITS.memory_embed_batch;
        for (let i = 0; i < missing.length; i += BATCH) {
            const slice = missing.slice(i, i + BATCH);
            let embeddings = await safeEmbed({ embedder: useEmbedder, text: slice.map(f => f.content) });
            const isVectorBatch = Array.isArray(embeddings)
                && embeddings.length === slice.length
                && embeddings.every(e => e === null || Array.isArray(e));
            if (embeddings === null) {
                embeddings = slice.map(() => null);
            } else if (!isVectorBatch) {
                embeddings = await Promise.all(slice.map(f => safeEmbed({ embedder: useEmbedder, text: f.content })));
            }
            for (let j = 0; j < slice.length; j++) {
                const emb = embeddings[j];
                if (Array.isArray(emb) && emb.length > 0) {
                    slice[j].embedding = emb;
                    slice[j].dimension = emb.length;
                    this._embedFailedIds.delete(slice[j].id);
                    changed = true;
                } else {
                    this._embedFailedIds.add(slice[j].id);
                }
            }
        }
        if (changed) {
            try {
                await this.save();
            } catch (err) {
                sdkLog({ prefix: LOG_PREFIX_MEMORY, args: [`Failed to persist backfilled embeddings for bank '${this.name}': ${(/** @type {any} */ (err)).message}`] });
            }
        }
    }
}


/**
 * SQLite-backed memory bank. Same fact/query/history contract as
 * `LocalFileMemoryProvider`; the bank is one row in a `memory_bank` table, so
 * a save is a single transaction and two processes cannot lose each other's
 * merge. `node:sqlite` is imported lazily, so a file-backed user never sees
 * its ExperimentalWarning.
 *
 * Requires Node ≥22.13 (`engines` enforces it).
 * @extends {LocalFileMemoryProvider}
 */
export class SqliteMemoryProvider extends LocalFileMemoryProvider {
    /**
     * @param {{options?: LocalFileMemoryProviderOptions & {busyTimeoutMs?: number}}} arg0
     */
        constructor({ options = {} } = {}) {
        super({ options });
        this.filePath = /** @type {string} */ (options.filePath || DEFAULT_MEMORY_SQLITE_PATH);
        this.busyTimeoutMs = Number(options.busyTimeoutMs ?? LIMITS.memory_busy_timeout_ms);
        /** @type {boolean} */
        this._loaded = false;
        /** @type {import('node:sqlite').DatabaseSync|null} */
        this._db = null;
    }

    /** Opens the database once and creates the bank table. @returns {Promise<import('node:sqlite').DatabaseSync>} */
    async #open() {
        if (this._db) return this._db;
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(this.filePath);
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec(`PRAGMA busy_timeout = ${Number.isFinite(this.busyTimeoutMs) ? this.busyTimeoutMs : LIMITS.memory_busy_timeout_ms};`);
        db.exec('CREATE TABLE IF NOT EXISTS memory_bank (name TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);');
        this._db = db;
        return db;
    }

    /** @returns {Promise<void>} */
        async load() {
        if (this._loaded) return;
        const db = await this.#open();
        const row = /** @type {{version?: number, payload?: string}|undefined} */ (db.prepare('SELECT version, payload FROM memory_bank WHERE name = ?').get(this.name));
        if (!row || typeof row.payload !== 'string') {
            this.facts = [];
            this._lastSyncedTurnIndex = 0;
            this._loadedSyncIndex = 0;
            this._loaded = true;
            sdkLog({ prefix: LOG_PREFIX_MEMORY, args: [`No existing SQLite memory bank '${this.name}' at ${this.filePath}. Starting fresh.`] });
            return;
        }
        const parsed = validateStrict({ input: row.payload, schema: MEMORY_BANK_SCHEMA });
        if (!parsed.success || row.version !== MEMORY_BANK_VERSION) {
            sdkWarn({ prefix: LOG_PREFIX_MEMORY, args: [`SQLite memory bank '${this.name}' is corrupt or has version ${row.version}; dropping the row and starting empty.`] });
            db.prepare('DELETE FROM memory_bank WHERE name = ?').run(this.name);
            this.facts = [];
            this._lastSyncedTurnIndex = 0;
            this._loadedSyncIndex = 0;
            this._loaded = true;
            return;
        }
        const data = /** @type {Record<string, any>} */ (parsed.data);
        this._history = Array.isArray(data.history) ? data.history.slice(-LIMITS.memory_max_history_rows) : [];
        this._deletedIds = new Set(Array.isArray(data.deletedIds) ? data.deletedIds.filter((/** @type {*} */ id) => typeof id === 'string') : []);
        this.facts = (/** @type {Array<MemoryFact>} */ (Array.isArray(data.facts) ? data.facts : []))
            .filter(f => !(f && f.id !== undefined && this._deletedIds.has(f.id)));
        this._lastSyncedTurnIndex = typeof data.lastSyncedTurnIndex === 'number' ? data.lastSyncedTurnIndex : 0;
        this._loadedSyncIndex = this._lastSyncedTurnIndex;
        this._loaded = true;
        sdkLog({ prefix: LOG_PREFIX_MEMORY, args: [`Loaded ${this.facts.length} facts from SQLite bank '${this.name}' (${this.filePath})`] });
    }

    /**
     * Persists the bank in one transaction. The read-merge-write mirrors the
     * file provider, so a second writer's facts and audit rows survive.
     * @returns {Promise<void>}
     */
        async save() {
        const db = await this.#open();
        db.exec('BEGIN IMMEDIATE');
        try {
            const row = /** @type {{payload?: string}|undefined} */ (db.prepare('SELECT payload FROM memory_bank WHERE name = ?').get(this.name));
            if (row && typeof row.payload === 'string') {
                const other = validateStrict({ input: row.payload, schema: MEMORY_BANK_SCHEMA });
                const data = other.success && other.data && typeof other.data === 'object' ? /** @type {Record<string, any>} */ (other.data) : null;
                if (data && Array.isArray(data.facts)) {
                    for (const id of Array.isArray(data.deletedIds) ? data.deletedIds : []) {
                        if (typeof id === 'string') this._deletedIds.add(id);
                    }
                    if (this._deletedIds.size > 0) this.facts = this.facts.filter(f => !this._deletedIds.has(f.id));
                    const known = new Set(this.facts.map(f => f.id));
                    for (const fact of data.facts) {
                        if (fact && fact.id !== undefined && !known.has(fact.id) && !this._deletedIds.has(fact.id)) {
                            known.add(fact.id);
                            this.facts.push(fact);
                        }
                    }
                    if (this.facts.length > LIMITS.memory_max_facts_per_bank) {
                        this.facts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                        this.facts.length = LIMITS.memory_max_facts_per_bank;
                    }
                    const diskHistory = Array.isArray(data.history) ? data.history : [];
                    if (diskHistory.length > 0) {
                        const seen = new Set(this._history.map((entry) => `${entry.ts}|${entry.event}|${entry.id}|${entry.new ?? ''}`));
                        this._history = [...this._history, ...diskHistory.filter((/** @type {any} */ entry) => !seen.has(`${entry.ts}|${entry.event}|${entry.id}|${entry.new ?? ''}`))]
                            .sort((a, b) => (a.ts || 0) - (b.ts || 0))
                            .slice(-LIMITS.memory_max_history_rows);
                    }
                }
            }
            const payload = JSON.stringify({
                version: MEMORY_BANK_VERSION,
                facts: this.facts,
                lastSyncedTurnIndex: this._lastSyncedTurnIndex,
                history: this._history,
                deletedIds: Array.from(this._deletedIds).slice(-LIMITS.memory_max_facts_per_bank),
            });
            db.prepare('INSERT INTO memory_bank (name, version, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET version = excluded.version, payload = excluded.payload, updated_at = excluded.updated_at')
                .run(this.name, MEMORY_BANK_VERSION, payload, Date.now());
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    }

    /** Closes the database handle (idempotent). */
        close() {
        if (this._db) {
            this._db.close();
            this._db = null;
        }
    }
}


/**
 * Fan-out memory provider across named banks. Queries merge + dedupe all
 * banks (score-ranked when any fact is scored, else recency); store routes to
 * `targetBanks` (defaulting to the default bank).
 * @extends {MemoryProvider}
 */
export class CompositeMemoryProvider extends MemoryProvider {
    
    /** @param {{providers?: Array<CompositeProvider>, defaultBankName?: string|null}} arg0 */
    constructor({ providers = [], defaultBankName = null } = {}) {
        super();
        this.providers = /** @type {Map<string, CompositeProvider>} */ (new Map());
        for (const p of providers) {
            this.providers.set(p.name, p);
        }
        this.defaultBankName = /** @type {string} */ (defaultBankName || (providers.length > 0 ? providers[0].name : DEFAULT_MEMORY_BANK_NAME));
        this.name = COMPOSITE_MEMORY_BANK_NAME;
        this.description = COMPOSITE_MEMORY_BANK_DESC;
    }

    
    /** The default bank's persisted sync checkpoint. */
        get lastSyncedTurnIndex() {
        const defaultProvider = this.providers.get(this.defaultBankName);
        return defaultProvider ? (defaultProvider.lastSyncedTurnIndex ?? 0) : 0;
    }

    
    /** Sets the default bank's persisted sync checkpoint. */
        set lastSyncedTurnIndex(val) {
        const defaultProvider = this.providers.get(this.defaultBankName);
        if (defaultProvider) defaultProvider.lastSyncedTurnIndex = val;
    }

    
    /** The default bank's cursor as restored from disk. */
        get restoredSyncIndex() {
        const defaultProvider = this.providers.get(this.defaultBankName);
        return defaultProvider ? (defaultProvider.restoredSyncIndex ?? 0) : 0;
    }

    
    /**
     * Combined bank roster across all providers.
     * @returns {string}
     */
        getBankDescriptions() {
        let desc = '';
        for (const [name, p] of this.providers.entries()) {
            desc += `- "${name}": ${p.description ?? ''}\n`;
        }
        return desc;
    }

    
    /**
     * error when EVERY bank failed.
     * @param {{op: string, names: Array<string>, settled: Array<PromiseSettledResult<any>>, throwOnAll?: boolean}} arg0 -
     */
        #reportBankFailures({ op, names, settled, throwOnAll = false }) {
        let failures = 0;
        
        /** @type {unknown} */
                let firstError = null;
        settled.forEach((result, i) => {
            if (result.status !== 'rejected') return;
            failures++;
            if (firstError === null) firstError = result.reason;
            const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
            sdkWarn({ prefix: LOG_PREFIX_MEMORY, args: [`Memory bank '${names[i]}' ${op} failed: ${message}`] });
        });
        if (throwOnAll && failures === settled.length && failures > 0) throw firstError;
    }

    
    /**
     * Loads every bank, isolating per-bank failures.
     * @returns {Promise<void>}
     */
        async load() {
        const entries = Array.from(this.providers.entries());
        const settled = await Promise.allSettled(entries.map(([, p]) => p.load()));
        this.#reportBankFailures({ op: 'load', names: entries.map(([name]) => name), settled, throwOnAll: true });
    }

    
    /**
     * Saves every bank, isolating per-bank failures.
     * @returns {Promise<void>}
     */
        async save() {
        const entries = Array.from(this.providers.entries());
        const settled = await Promise.allSettled(entries.map(([, p]) => p.save()));
        this.#reportBankFailures({ op: 'save', names: entries.map(([name]) => name), settled, throwOnAll: true });
    }

    
    /**
     * the higher-scoring duplicate), then ranks by score (when any fact is
     * scored) or recency. A failing bank only warns.
     * @param {{text: string, limit?: number, embedder?: Function|null}} arg0 -
     * @returns {Promise<Array<MemoryFact>>}
     */
        async query({ text, limit = LIMITS.memory_query_limit, embedder = null }) {
        const entries = Array.from(this.providers.entries());
        const settled = await Promise.allSettled(entries.map(([, p]) => p.query({ text, limit, embedder })));
        this.#reportBankFailures({ op: 'query', names: entries.map(([name]) => name), settled, throwOnAll: true });
        const flat = [];
        for (const result of settled) {
            if (result.status === 'fulfilled') flat.push(...(result.value || []));
        }

        const indexByContent = new Map();
        const deduped = [];
        for (const fact of flat) {
            const normalized = String(fact.content || '').toLowerCase().trim();
            const existingIdx = indexByContent.get(normalized);
            if (existingIdx === undefined) {
                indexByContent.set(normalized, deduped.length);
                deduped.push(fact);
            } else if ((fact.score || 0) > (deduped[existingIdx].score || 0)) {
                deduped[existingIdx] = fact;
            }
        }

        const hasScored = deduped.some(f => typeof f.score === 'number' && f.score > 0);
        if (hasScored) {
            return deduped.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);
        }
        return deduped.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, limit);
    }

    
    /**
     * @param {{content: string, category?: string, targetBanks?: Array<string>, embedder?: Function|null, opts?: MemoryStoreOptions}} arg0 -
     * @returns {Promise<MemoryFact|null>} the first stored fact, or null.
     */
        async store({ content, category, targetBanks = [], embedder = null, opts = {} }) {
        let targets = Array.isArray(targetBanks) ? targetBanks : [targetBanks];
        if (targets.length === 0) targets = [this.defaultBankName];

        const storedFacts = [];
        let firstError = null;
        for (const t of targets) {
            let provider = this.providers.get(t);
            if (!provider) {
                sdkLog({ prefix: LOG_PREFIX_MEMORY, args: [`Warning: Target bank '${t}' not found. Routing to default.`] });
                provider = this.providers.get(this.defaultBankName);
            }
            if (!provider) continue;
            try {
                const fact = await provider.store({ content, category, targetBanks: [], embedder, opts });
                if (fact) storedFacts.push(fact);
            } catch (err) {
                if (firstError === null) firstError = err;
                const message = err instanceof Error ? err.message : String(err);
                sdkWarn({ prefix: LOG_PREFIX_MEMORY, args: [`Memory bank '${provider.name}' store failed: ${message}`] });
            }
        }
        if (storedFacts.length > 0) return storedFacts[0];
        if (firstError) throw firstError;
        return null;
    }

    
    /**
     * @param {{id: string, opts?: MemoryStoreOptions}} arg0 -
     * @returns {Promise<boolean>} whether anything was deleted.
     */
        async delete({ id, opts = {} }) {
        let deletedAny = false;
        let firstError = null;
        for (const [name, p] of this.providers.entries()) {
            try {
                if (await p.delete({ id, opts })) deletedAny = true;
            } catch (err) {
                if (firstError === null) firstError = err;
                const message = err instanceof Error ? err.message : String(err);
                sdkWarn({ prefix: LOG_PREFIX_MEMORY, args: [`Memory bank '${name}' delete failed: ${message}`] });
            }
        }
        if (!deletedAny && firstError) throw firstError;
        return deletedAny;
    }

    
    /**
     * Clears every bank, isolating per-bank failures.
     * @returns {Promise<void>}
     */
        async clear() {
        const entries = Array.from(this.providers.entries());
        const settled = await Promise.allSettled(entries.map(([, p]) => p.clear()));
        this.#reportBankFailures({ op: 'clear', names: entries.map(([name]) => name), settled, throwOnAll: true });
    }
}
