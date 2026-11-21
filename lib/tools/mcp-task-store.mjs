// @ts-check
/**
 * @file The task store behind the legacy MCP Tasks interop.
 * @version 0.12.0
 *
 * @description
 * The 2025-11-25 task vocabulary has no SDK runtime, so the server keeps its
 * own store: a task record, the abort controller that cancels its tool, and a
 * retention timer that starts only when the task reaches a terminal state.
 * Extracted from `mcp-server.mjs` so the lifecycle is testable on its own and a
 * future durable store can replace it without touching the protocol handlers.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BackendError, ConfigurationError } from '../core/errors.mjs';
import { ERROR_CODES } from '../core/constants/index.mjs';
import { LIMIT_REGISTRY } from '../core/constants/limits.mjs';
import { LIMITS } from '../core/limit-config.mjs';
import { readStoredJsonSync, writeJsonAtomicSync } from '../support/fs-store.mjs';
import { sdkWarn } from '../support/utils.mjs';

/** @typedef {import('./mcp-client.mjs').McpTask} McpTask */

/**
 * Tasks returned by one `tasks/list` page.
 * Code default only; the effective page size is `LIMITS.mcp_task_page_size` (`getLimits()`).
 */
export const MCP_TASK_PAGE_SIZE = LIMIT_REGISTRY.mcp_task_page_size.default;


/**
 * Maps a store error onto the wire: an unknown task is invalid params with the
 * domain code in `data`, so a client can branch without the message. JSON-RPC
 * reserves `error.code` for the number, so the domain code never rides there.
 * Any other error passes through untouched.
 * @param {{err: unknown}} arg0
 * @returns {unknown}
 */
export function toWireTaskError({ err }) {
    const typed = /** @type {any} */ (err);
    if (typed?.code !== ERROR_CODES.MCP_UNKNOWN_TASK) return err;
    return Object.assign(new Error(typed.message), {
        code: -32602,
        data: { code: ERROR_CODES.MCP_UNKNOWN_TASK, taskId: typed.context?.taskId },
    });
}


/**
 * The other direction: restores the `data.code` of a task response as a
 * `BackendError` code the caller can branch on, keeping the wire's message and
 * the received error as its cause. Any other error passes through untouched.
 * @param {{error: unknown}} arg0
 * @returns {unknown}
 */
export function fromWireTaskError({ error }) {
    const typed = /** @type {any} */ (error);
    const data = typed?.data;
    if (data?.code !== ERROR_CODES.MCP_UNKNOWN_TASK) return error;
    return new BackendError({
        message: typed?.message ?? `Unknown task: ${data.taskId}`,
        options: { code: ERROR_CODES.MCP_UNKNOWN_TASK, context: { taskId: data.taskId }, cause: error },
    });
}

/**
 * One task plus the live objects its run needs.
 * @typedef {Object} TaskEntry
 * @property {McpTask} task
 * @property {unknown} result
 * @property {unknown} error
 * @property {AbortController} controller
 * @property {ReturnType<typeof setTimeout>|null} timer
 * @property {((task: McpTask) => void)|null} onStatus
 */

/**
 * What a task store must implement. Pass an object with these methods as the
 * `taskStore` option to persist tasks. The server calls `start` with the run
 * and a status callback, and calls `close` only on the store it created
 * itself: a supplied store is owned (and closed) by its caller.
 *
 * `list` pages by task id: return the tasks after `cursor` (or from the first
 * when `cursor` is null) and set `nextCursor` while more remain.
 *
 * @typedef {Object} McpTaskStoreLike
 * @property {(arg0: {run: (arg0: {signal: AbortSignal}) => Promise<unknown>, ttl?: number|null, onStatus?: ((task: McpTask) => void)|null}) => McpTask} start
 * @property {(arg0: {taskId: string}) => McpTask} get
 * @property {(arg0: {taskId: string}) => unknown} result
 * @property {(arg0: {cursor?: string|null}) => {tasks: Array<McpTask>, nextCursor?: string}} list
 * @property {(arg0: {taskId: string}) => McpTask} cancel
 * @property {() => void} close
 */

/**
 * In-memory task store: a task record, its abort controller and its retention
 * timer. Each server creates one by default, so a task is reachable only from
 * the connection that created it; pass an instance as `taskStore` to share or
 * persist tasks across sessions.
 */
export class McpTaskStore {
    /**
     * @param {{defaultTtlMs?: number, defaultPollIntervalMs?: number, pageSize?: number}} [options]
     */
    constructor({ defaultTtlMs = LIMITS.mcp_task_ttl_ms, defaultPollIntervalMs = LIMITS.mcp_task_poll_ms, pageSize = LIMITS.mcp_task_page_size } = {}) {
        this.defaultTtlMs = defaultTtlMs;
        this.defaultPollIntervalMs = defaultPollIntervalMs;
        this.pageSize = Math.max(1, Number(pageSize) || LIMITS.mcp_task_page_size);
        /** @type {Map<string, TaskEntry>} */
        this._entries = new Map();
    }

    /**
     * Starts a run and returns its task immediately.
     * @param {{run: (arg0: {signal: AbortSignal}) => Promise<unknown>, ttl?: number|null, onStatus?: ((task: McpTask) => void)|null}} arg0
     * @returns {McpTask}
     */
    start({ run, ttl = null, onStatus = null }) {
        const now = new Date().toISOString();
        /** @type {TaskEntry} */
        const entry = {
            task: {
                taskId: randomUUID(),
                status: 'working',
                ttl: typeof ttl === 'number' ? ttl : this.defaultTtlMs,
                createdAt: now,
                lastUpdatedAt: now,
                pollInterval: this.defaultPollIntervalMs,
            },
            result: null,
            error: null,
            controller: new AbortController(),
            timer: null,
            onStatus,
        };
        this._entries.set(entry.task.taskId, entry);
        this._onChange(entry);
        void Promise.resolve()
            .then(() => run({ signal: entry.controller.signal }))
            .then((result) => {
                // A cancel already published `cancelled`; a late result must not revive it.
                if (entry.controller.signal.aborted) return;
                entry.result = result;
                this.#update({ entry, status: 'completed' });
            })
            .catch((err) => {
                if (entry.controller.signal.aborted) return;
                entry.error = err;
                this.#update({ entry, status: 'failed', extra: { statusMessage: (/** @type {any} */ (err))?.message ?? String(err) } });
            });
        return entry.task;
    }

    /**
     * @param {{taskId: string}} arg0
     * @returns {McpTask}
     */
    get({ taskId }) {
        return this.#entry({ taskId }).task;
    }

    /**
     * The completed result, or the failure the tool produced.
     * @param {{taskId: string}} arg0
     * @returns {unknown}
     */
    result({ taskId }) {
        const entry = this.#entry({ taskId });
        if (entry.task.status === 'completed') return entry.result;
        if (entry.task.status === 'failed') throw entry.error ?? new Error(entry.task.statusMessage ?? 'Task failed');
        throw new Error(`Task ${entry.task.taskId} is ${entry.task.status}.`);
    }

    /**
     * One page of tasks, after `cursor`. The cursor is the last task id of the
     * previous page; `nextCursor` is present while more remain.
     * @param {{cursor?: string|null}} [arg0]
     * @returns {{tasks: Array<McpTask>, nextCursor?: string}}
     */
    list({ cursor = null } = {}) {
        const all = [...this._entries.values()].map((entry) => entry.task);
        const after = cursor ? all.findIndex((task) => task.taskId === cursor) : -1;
        if (cursor && after < 0) {
            // A cursor whose task expired between pages cannot be resumed: the
            // spec's answer to an invalid cursor is an error, not a repeat.
            throw new BackendError({ message: `Invalid task cursor: ${cursor}`, options: { context: { cursor } } });
        }
        const start = after + 1;
        const tasks = all.slice(start, start + this.pageSize);
        const next = start + tasks.length;
        return { tasks, ...(next < all.length ? { nextCursor: tasks[tasks.length - 1].taskId } : {}) };
    }

    /**
     * Aborts a working task. A terminal task is returned unchanged (idempotent).
     * @param {{taskId: string}} arg0
     * @returns {McpTask}
     */
    cancel({ taskId }) {
        const entry = this.#entry({ taskId });
        if (entry.task.status === 'working' || entry.task.status === 'input_required') {
            entry.controller.abort();
            if (entry.timer) clearTimeout(entry.timer);
            this.#update({ entry, status: 'cancelled' });
        }
        return entry.task;
    }

    /** Aborts every task still in flight and drops the store. */
    close() {
        for (const entry of this._entries.values()) {
            if (!entry.controller.signal.aborted) entry.controller.abort();
            if (entry.timer) clearTimeout(entry.timer);
        }
        this._entries.clear();
    }

    /** @param {{taskId: string}} arg0 @returns {TaskEntry} */
    #entry({ taskId }) {
        const entry = this._entries.get(String(taskId));
        if (!entry) {
            throw new BackendError({
                message: `Unknown task: ${taskId}`,
                options: { code: ERROR_CODES.MCP_UNKNOWN_TASK, context: { taskId } },
            });
        }
        return entry;
    }

    /**
     * @param {{entry: TaskEntry, status: string, extra?: Record<string, unknown>}} arg0
     */
    #update({ entry, status, extra = {} }) {
        entry.task.status = /** @type {McpTask['status']} */ (status);
        entry.task.lastUpdatedAt = new Date().toISOString();
        Object.assign(entry.task, extra);
        entry.onStatus?.(entry.task);
        // `ttl` is a retention window from the last update, not a run deadline:
        // a working task must not expire while its tool is still running.
        if (status === 'completed' || status === 'failed' || status === 'cancelled') this._scheduleTtl({ entry });
        this._onChange(entry);
    }

    /**
     * Runs after every task record change. The in-memory store has nothing to
     * flush; a durable subclass writes the record here.
     * @param {TaskEntry} entry
     * @returns {void}
     */
    _onChange(entry) {}

    /**
     * Drops a task once its retention window ends. A durable subclass also
     * removes its stored record.
     * @param {string} taskId
     * @returns {void}
     */
    _drop(taskId) {
        this._entries.delete(taskId);
    }

    /**
     * @param {{entry: TaskEntry, delayMs?: number|null}} arg0
     * @returns {void}
     */
    _scheduleTtl({ entry, delayMs = null }) {
        if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
        const ttl = delayMs ?? Number(entry.task.ttl);
        if (!Number.isFinite(ttl) || ttl <= 0) return;
        entry.timer = setTimeout(() => { this._drop(entry.task.taskId); }, ttl);
        entry.timer.unref?.();
    }
}

/**
 * A durable store: one JSON record per task under `dir`, reloaded on
 * construction, so a task and its result survive a restart. A run cannot
 * resume without the process that started it, so a task still `working` when
 * the store loads becomes `failed` with a restart message.
 *
 * `close()` aborts the live runs and stops the retention timers but keeps the
 * files. One process owns a directory: there is no cross-process locking, and
 * the in-memory copy is authoritative for the lifetime of the store.
 */
export class FileMcpTaskStore extends McpTaskStore {
    /**
     * @param {{dir: string, defaultTtlMs?: number, defaultPollIntervalMs?: number, pageSize?: number}} arg0
     */
    constructor({ dir, defaultTtlMs, defaultPollIntervalMs, pageSize }) {
        if (typeof dir !== 'string' || dir.length === 0) {
            throw new ConfigurationError({
                message: 'FileMcpTaskStore requires a non-empty dir.',
                options: { option: 'dir' },
            });
        }
        super({ defaultTtlMs, defaultPollIntervalMs, pageSize });
        this.dir = dir;
        mkdirSync(this.dir, { recursive: true });
        this.#load();
    }

    /** @param {TaskEntry} entry @returns {void} */
    _onChange(entry) {
        this.#write(entry);
    }

    /** @param {string} taskId @returns {void} */
    _drop(taskId) {
        super._drop(taskId);
        this.#remove(taskId);
    }

    /** @param {string} taskId @returns {string} */
    #file(taskId) {
        return join(this.dir, `${taskId}.json`);
    }

    /** @param {TaskEntry} entry @returns {void} */
    #write(entry) {
        try {
            writeJsonAtomicSync({
                filePath: this.#file(entry.task.taskId),
                data: { version: 1, task: entry.task, result: entry.result ?? null },
            });
        } catch (err) {
            // A failed write must not turn a completed tool into a failed task:
            // the in-memory copy stays authoritative for this process.
            sdkWarn({ prefix: 'MCP-TASK', args: [`could not persist task ${entry.task.taskId}: ${(/** @type {any} */ (err))?.message ?? String(err)}`] });
        }
    }

    /** @param {string} taskId @returns {void} */
    #remove(taskId) {
        try {
            rmSync(this.#file(taskId), { force: true });
        } catch (err) {
            sdkWarn({ prefix: 'MCP-TASK', args: [`could not remove task ${taskId}: ${(/** @type {any} */ (err))?.message ?? String(err)}`] });
        }
    }

    /** Loads every record and applies the restart and retention rules. */
    #load() {
        /** @type {Array<string>} */
        let names;
        try {
            names = readdirSync(this.dir);
        } catch (err) {
            sdkWarn({ prefix: 'MCP-TASK', args: [`could not read ${this.dir}: ${(/** @type {any} */ (err))?.message ?? String(err)}`] });
            return;
        }
        for (const name of names) {
            if (!name.endsWith('.json')) continue;
            const file = join(this.dir, name);
            /** @type {{status: string, value?: any, reason?: string}} */
            let read;
            try {
                read = readStoredJsonSync({ filePath: file });
            } catch (err) {
                // Readable-directory but unreadable entry (a directory named
                // `x.json`, a permission error): as unreadable as a bad parse.
                read = { status: 'corrupt', reason: (/** @type {any} */ (err))?.message ?? String(err) };
            }
            if (read.status !== 'ok') {
                // Left in place for inspection; a later construction retries it.
                sdkWarn({ prefix: 'MCP-TASK', args: [`ignoring unreadable task file ${name}: ${read.reason ?? 'missing'}`] });
                continue;
            }
            /** @type {any} */
            const record = read.value;
            if (record?.version !== 1) {
                sdkWarn({ prefix: 'MCP-TASK', args: [`ignoring task file ${name} with an unknown version ${String(record?.version)}`] });
                continue;
            }
            const task = record?.task;
            if (!task || typeof task.taskId !== 'string' || typeof task.status !== 'string') {
                sdkWarn({ prefix: 'MCP-TASK', args: [`ignoring malformed task file ${name}`] });
                continue;
            }
            /** @type {TaskEntry} */
            const entry = {
                task,
                result: record.result ?? null,
                error: null,
                controller: new AbortController(),
                timer: null,
                onStatus: null,
            };
            const now = Date.now();
            if (task.status === 'working' || task.status === 'input_required') {
                task.status = 'failed';
                task.statusMessage = 'The server restarted while the task was running.';
                task.lastUpdatedAt = new Date(now).toISOString();
                entry.error = new Error(task.statusMessage);
                this.#write(entry);
            } else if (typeof task.statusMessage === 'string') {
                entry.error = new Error(task.statusMessage);
            }
            const ttl = Number(task.ttl);
            const updatedAt = Date.parse(task.lastUpdatedAt);
            if (Number.isFinite(ttl) && ttl > 0 && !Number.isFinite(updatedAt)) {
                sdkWarn({ prefix: 'MCP-TASK', args: [`ignoring task ${task.taskId} with an invalid lastUpdatedAt`] });
                continue;
            }
            if (Number.isFinite(ttl) && ttl > 0) {
                const elapsed = now - updatedAt;
                if (elapsed >= ttl) {
                    this.#remove(task.taskId);
                    continue;
                }
                this._scheduleTtl({ entry, delayMs: ttl - elapsed });
            }
            this._entries.set(task.taskId, entry);
        }
    }
}
