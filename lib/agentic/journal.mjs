// @ts-check


/**
 * @file Execution journal — at-most-once side effects under retries, replays
 * and resume.
 * @version 0.12.0
 *
 * @description
 * Append-only record of tool/step executions keyed by content-addressed
 * idempotency keys. A completed entry is replayed instead of re-executed; an
 * interrupted entry (previous attempt died mid-execution) is only re-run for
 * tools that declare themselves idempotent — everything else fails closed with
 * an explicit unknown-state result. In-memory by default (covers in-process
 * retries); `toJSON`/`fromJSON` are the durable form used by checkpoint/resume.
 */
import { createHash, randomUUID } from 'node:crypto';
import { OrchestrationError, ConfigurationError } from '../core/errors.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { canonicalJson } from '../support/utils.mjs';



/**
 * The states a journal entry can be in.
 * @typedef {'intent'|'done'|'failed'|'interrupted'} JournalStatus
 */

/**
 * The outcome a journal row replays. Only `success: true` replays as a success
 * (B1): a missing or malformed outcome is an unknown result, not a pass.
 * @typedef {Object} JournalOutcome
 * @property {boolean} [success]
 * @property {unknown} [result]
 * @property {string} [error]
 */

/**
 * One journal row: its identity, lifecycle, the meta the caller spread in, and
 * the attempt history (flat — each stored attempt drops its own `attempts`).
 * @typedef {Object} JournalEntry
 * @property {string} [key]
 * @property {string} runId
 * @property {number} seq
 * @property {JournalStatus} status
 * @property {number} startedAt
 * @property {number|null} endedAt
 * @property {JournalOutcome} [outcome]
 * @property {string} [error]
 * @property {boolean} [retryable] - A failed call that provably did not reach its effect.
 * @property {unknown} [reason]
 * @property {{inputTokens?: number, outputTokens?: number, totalTokens?: number}} [usage]
 * @property {Array<JournalEntry>} [attempts]
 * @property {string} [kind] - The row kind a caller recorded (the tool path writes 'tool').
 * @property {string} [name]
 * @property {string|number|null} [boundary] - The step/branch the call belongs to (B6).
 * @property {unknown} [args] - What the call was made with (B6).
 * @property {string|null} [sessionId]
 * @property {string|null} [parentRunId]
 */
export const JOURNAL_STATUS = Object.freeze({
    INTENT:  ('intent'),
    DONE:  ('done'),
    FAILED:  ('failed'),
    INTERRUPTED:  ('interrupted'),
});




/**
 * A stable 16-character key for a journal entry, derived from its parts. The
 * parts are keyed in strict mode (G1-10): two calls whose arguments differ in a
 * `Date`, `Map` or class instance must not share a key, and an unfoldable value
 * fails loudly instead of throwing a bare `TypeError`.
 * @returns {string} 16-char stable key
 * @param {{parts?: Array<unknown>}} arg0
 */
export function journalKey({ parts = [] } = {}) {
    return createHash('sha256')
        .update(parts.map(/** @type {(...args: any[]) => any} */ ((p) => (typeof p === 'string' ? p : canonicalJson({ value: p, strict: true })))).join('\u0000'))
        .digest('hex')
        .slice(0, LIMITS.journal_id_prefix_chars);
}


/**
 * The journal key of a tool call — the identity its outcome is recorded under.
 * The execution journal — an append-only record of what the agent did, so a run can be replayed or audited.
 * @param {{ runId?: string|null, boundary?: string|number|null, name?: string|null, args?: unknown }} input
 * @returns {string}
 */
export function toolJournalKey({ runId, boundary, name, args }) {
    return journalKey({ parts: ['tool', runId ?? '', String(boundary ?? ''), String(name ?? ''), args ?? null] });
}

/**
 * The execution journal — an append-only record of what the agent did, so a
 * run can be replayed or audited.
 */
/**
 * One row with a JSON-cloned outcome, or a fail-closed replacement (B1). Covers
 * the attempt history too: a prior attempt's outcome is serialized as well, and
 * a circular one there used to throw out of `JSON.stringify`.
 * @param {{row: any}} arg0
 * @returns {any}
 */
function safeOutcomeRow({ row }) {
    if (row?.outcome === undefined) return { ...row };
    try {
        return { ...row, outcome: JSON.parse(JSON.stringify(row.outcome)) };
    } catch {
        // Fail closed: a row whose outcome cannot be serialized must not replay
        // as a success with no result.
        const rest = { ...row };
        delete rest.outcome;
        return { ...rest, outcome: { success: false, error: 'Tool outcome is not serializable; the result is unknown.' } };
    }
}

export class ExecutionJournal {
    
    /** @type {Map<string, JournalEntry>} */
    #entries = new Map();
    #runId;
    /**
     * G1-1: an optional async sink that persists this journal. The tool path
     * awaits it between `begin()` and `execute()`, so a process crash leaves the
     * INTENT row on disk and the restart refuses to re-run the side effect.
     * @type {((arg0: {journal: ExecutionJournal}) => Promise<void>|void)|null}
     */
    onBegin = null;
    /** @type {Promise<void>} Serializes sink writes so a snapshot never regresses (A-2). */
    #sinkChain = Promise.resolve();
    // B6: a durable ordering id. `startedAt` is milliseconds and collides inside a
    // parallel wave; the sequence does not, and it survives a checkpoint.
    #seq = 0;

    
    /** @param {{ runId?: string|null }} [opts] */
        constructor({ runId = null } = {}) {
        this.#runId = runId ?? `jrn_${randomUUID().slice(0, LIMITS.journal_run_id_chars)}`;
    }

    get runId() {
        return this.#runId;
    }

    
    /** @param {{key: string}} arg0 @returns {JournalEntry|null} */
    get({ key }) {
        return this.#entries.get(key) ?? null;
    }

    
    /** @param {{key: string}} arg0 @returns {boolean} */
    has({ key }) {
        return this.#entries.has(key);
    }

    
    /**
     * @param {{key?: string, meta?: Record<string, unknown>}} arg0 -
     * @returns {JournalEntry}
     */
    begin({ key, meta = {} } = {}) {
        // `meta` is spread FIRST, and only its own fields: the journal's own
        // fields and the outcome/error channels are protected, so a caller
        // cannot manufacture a DONE row, re-key the ledger, or forge an
        // outcome (G0).
        const { outcome: _outcome, error: _error, ...rest } = meta ?? {};
        // A re-begun key keeps the attempts it already made (B2): the row is
        // overwritten as the CURRENT attempt, but the history rides along so an
        // audit can still answer "how many attempts, and what did each cost".
        const previous = this.#entries.get(/** @type {string} */ (key));
        // The history is flat, so N re-begins cost N rows — but N is still a caller
        // choice, and no production path re-begins a DONE key (a retry changes the
        // boundary). A caller that loops is refused loudly rather than growing one
        // row without limit: a silent cap would drop history, so the limit throws.
        const priorAttempts = Array.isArray(previous?.attempts) ? previous.attempts : [];
        const maxAttempts = LIMITS.journal_max_attempts;
        if (previous && priorAttempts.length + 1 >= maxAttempts) {
            throw new OrchestrationError({ message: `ExecutionJournal: ${maxAttempts} attempts recorded for key '${String(key)}'; refusing to append another. A retry should use a new key/boundary.`, options: { context: { key, attempts: priorAttempts.length + 1, maxAttempts } } });
        }
        // Flat, not nested: each stored attempt drops the `attempts` it carried, so
        // N re-begins cost N rows, not 2^N (the verifier measured 2.4 MB from twelve
        // 1 KB re-begins before this).
        const flatPrevious = previous
            ? (() => { const { attempts: _carried, ...flat } = previous; return flat; })()
            : null;
        this.#seq += 1;
        const entry = {
            ...rest,
            ...(flatPrevious ? { attempts: [...(Array.isArray(previous?.attempts) ? previous.attempts : []), flatPrevious] } : {}),
            key,
            runId: this.#runId,
            seq: this.#seq,
            status: JOURNAL_STATUS.INTENT,
            startedAt: Date.now(),
            endedAt: null,
        };
        this.#entries.set(/** @type {string} */ (key), entry);
        return entry;
    }

    
    /**
     * Awaits the durable sink for the row `begin()` just wrote (G1-1). A sink
     * failure propagates: an intent that cannot be persisted means at-most-once
     * cannot be promised, so the effect must not start.
     * @returns {Promise<void>}
     */
    async persistIntent() {
        if (typeof this.onBegin !== 'function') return;
        // A-2: parallel tool calls begin before either write lands. Serializing the
        // writes (and snapshotting inside the sink) keeps the last write a superset,
        // so no sibling's INTENT row is clobbered by a slower, earlier snapshot.
        const run = async () => { await /** @type {Function} */ (this.onBegin)({ journal: this }); };
        // A failed write must not leave the chain rejected: the caller still
        // sees the rejection (the intent is not durable), but the next call
        // retries the recovered store instead of rethrowing the stale error.
        const next = this.#sinkChain.then(run, run);
        this.#sinkChain = next.catch(() => {});
        await next;
    }

    /**
     * Adopts the durable run id of a restored journal (A-1). Every tool key hashes
     * the run id, so a crash with no checkpoint must keep the id the crashed
     * process used or the INTENT row can never match.
     * @param {{runId: unknown}} arg0
     * @returns {void}
     */
    adoptRunId({ runId }) {
        if (typeof runId === 'string' && runId.length > 0) this.#runId = runId;
    }

    /**
     * Folds rows restored from the sibling journal file into this one (G1-1).
     * A DONE row always wins (a completed side effect must replay, never re-run);
     * otherwise the later attempt wins. Keys from `other` that this journal does
     * not have are added, so a call that began after the last checkpoint is
     * still an unknown-state row on resume.
     * @param {{other: ExecutionJournal|null|undefined}} arg0
     * @returns {void}
     */
    merge({ other }) {
        if (!other) return;
        // A-1: the journal key hashes `runId`, so a restart with a fresh random id
        // would compute different keys and never match the crashed attempt's
        // INTENT row. Adopt the persisted id ONLY into an empty journal: a
        // journal that already holds rows (a checkpoint) keeps its own identity,
        // or a stale sibling from another run would make a DONE row unreachable
        // and re-run its effect.
        if (this.#entries.size === 0 && typeof other.runId === 'string' && other.runId !== '') {
            this.#runId = other.runId;
        }
        for (const row of other.entries()) {
            if (typeof row.key !== 'string') continue;
            const mine = this.#entries.get(row.key);
            if (!mine) {
                this.#entries.set(row.key, { ...row });
            } else if (mine.status !== JOURNAL_STATUS.DONE && row.status === JOURNAL_STATUS.DONE) {
                this.#entries.set(row.key, { ...row });
            } else if (mine.status !== JOURNAL_STATUS.DONE && row.startedAt >= mine.startedAt) {
                this.#entries.set(row.key, { ...row });
            }
            if (Number.isInteger(row.seq)) this.#seq = Math.max(this.#seq, row.seq);
        }
    }

    /**
     * @param {{key: string, outcome: unknown, usage?: {inputTokens?: number, outputTokens?: number, totalTokens?: number}|null}} arg0
     *   `usage` is what the call cost, when the caller knows it (a tool row usually
     *   does not; a step-level row can carry the attempt's tokens).
     * @returns {JournalEntry}
     */
    complete({ key, outcome, usage = null }) {
        const entry = this.#entries.get(key) ?? this.begin({ key });
        entry.status = JOURNAL_STATUS.DONE;
        entry.outcome = /** @type {JournalOutcome|undefined} */ (outcome);
        if (usage && typeof usage === 'object') entry.usage = usage;
        entry.endedAt = Date.now();
        return entry;
    }

    
    /**
     * @param {{key: string, error: unknown, retryable?: boolean}} arg0 -
     *   `retryable` marks a failure that is known to have happened BEFORE the
     *   effect (a refused argument, a validation error), the only `failed` row a
     *   resume may re-run without an idempotent tool (G1-2).
     * @returns {JournalEntry}
     */
    fail({ key, error, retryable = false }) {
        const entry = this.#entries.get(key) ?? this.begin({ key });
        entry.status = JOURNAL_STATUS.FAILED;
        const cause = /** @type {{message?: unknown}} */ (error);
        entry.error = String(cause?.message ?? error);
        if (retryable === true) entry.retryable = true;
        entry.endedAt = Date.now();
        return entry;
    }

    
    /** @param {{key: string, reason?: unknown}} arg0 @returns {JournalEntry} */
    interrupt({ key, reason = '' }) {
        const entry = this.#entries.get(key) ?? this.begin({ key });
        entry.status = JOURNAL_STATUS.INTERRUPTED;
        entry.reason = reason;
        entry.endedAt = Date.now();
        return entry;
    }

    /**
     * The rows in insertion order (which is also `seq` order within one journal).
     * @returns {Array<JournalEntry>}
     */
    entries() {
        return [...this.#entries.values()];
    }

    
    /**
     * Durable form — outcomes ride along so a resumed session replays them.
     * @returns {{version: number, runId: string, entries: Array<JournalEntry>}}
     */
    toJSON() {
        return {
            version: 1,
            runId: this.#runId,
            entries: this.entries().map((entry) => {
                const withAttempts = Array.isArray(entry.attempts)
                    ? { ...entry, attempts: entry.attempts.map((/** @type {any} */ attempt) => safeOutcomeRow({ row: attempt })) }
                    : entry;
                return safeOutcomeRow({ row: withAttempts });
            }),
        };
    }

    
    /**
     * Restores a journal from its durable form (`toJSON`). A live journal (the
     * shape `TaskState` can carry) is returned as is. A non-object, a
     * missing/non-array `entries`, or a version other than 1 throws: "garbage"
     * must not become an empty journal, or the resume replays every completed
     * side effect (G1-3).
     * @param {unknown} data
     * @returns {ExecutionJournal}
     */
    static fromJSON(data) {
        if (data instanceof ExecutionJournal) return data;
        const source = /** @type {{version?: unknown, runId?: string|null, entries?: Array<JournalEntry>}|null} */ (data);
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
            throw new ConfigurationError({ message: 'ExecutionJournal.fromJSON: journal must be an object.' });
        }
        if (source.version !== 1) {
            throw new ConfigurationError({ message: `ExecutionJournal.fromJSON: unsupported journal version ${String(source.version)} (expected 1).` });
        }
        if (!Array.isArray(source.entries)) {
            throw new ConfigurationError({ message: 'ExecutionJournal.fromJSON: journal entries must be an array.' });
        }
        const journal = new ExecutionJournal({ runId: source.runId ?? null });
        for (const entry of source.entries) {
            if (!entry || typeof entry.key !== 'string') continue;
            journal.#entries.set(entry.key, { ...entry });
            // Continue the sequence after the restored high-water mark, so a row
            // appended after a resume keeps ordering against the restored ones.
            if (Number.isInteger(entry.seq)) journal.#seq = Math.max(journal.#seq, entry.seq);
        }
        return journal;
    }
}

/**
 * The thread id a run's journal-only sibling file is stored under. The
 * checkpoint keeps the journal too, but it is written only at the end of an
 * attempt; the sibling is written before every side effect (G1-1).
 * @param {{threadId: string}} arg0
 * @returns {string}
 */
export function journalThreadId({ threadId }) {
    return `${threadId}.journal`;
}

/**
 * Wires a run's journal to a store, so `begin()` is durable before `execute()`.
 * No store, no wiring: an in-memory journal keeps its old contract.
 * @param {{journal: ExecutionJournal|null|undefined, store: {save: Function}|null|undefined, threadId: string|null|undefined}} arg0
 * @returns {void}
 */
export function attachJournalSink({ journal, store, threadId }) {
    if (!journal || !store || !threadId) return;
    journal.onBegin = async ({ journal: current }) => {
        await store.save({
            threadId: journalThreadId({ threadId }),
            data: { version: 1, threadId, journal: current.toJSON() },
        });
    };
}

/**
 * Folds the sibling journal (written before a side effect, possibly after the
 * last checkpoint) into the journal restored from the checkpoint. A DONE row in
 * either wins, so a completed effect is replayed and an in-flight one is
 * refused. A read failure propagates: an unreadable journal is not "no
 * journal", it means the side-effect state is unknown.
 * @param {{journal: ExecutionJournal|null|undefined, store: {load: Function}|null|undefined, threadId: string|null|undefined}} arg0
 * @returns {Promise<ExecutionJournal|null|undefined>}
 */
export async function restoreJournalSibling({ journal, store, threadId }) {
    if (!journal || !store || !threadId) return journal;
    const saved = await store.load(journalThreadId({ threadId }));
    const payload = saved?.journal;
    if (payload) {
        const restored = ExecutionJournal.fromJSON(payload);
        // A fresh journal (crash before any checkpoint) must take the crashed
        // run's id, or every restored key hashes differently and the intent is
        // invisible (A-1).
        if (journal.entries().length === 0) journal.adoptRunId({ runId: restored.runId });
        journal.merge({ other: restored });
    }
    return journal;
}
