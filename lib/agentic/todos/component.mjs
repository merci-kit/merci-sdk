// @ts-check
import { CAPABILITY, CAPABILITY_REGISTRY, LOAD_TODOS_TOOL_NAME, MANAGE_TODOS_TOOL_NAME } from '../../core/constants/index.mjs';
import { EVENTS } from '../../core/events.mjs';
import { LoadableComponent } from '../../core/loadable.mjs';
import { sdkWarn } from '../../support/utils.mjs';
import { readStoredJson, writeJsonAtomic, quarantineFile } from '../../support/fs-store.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { escapePromptField } from '../memory/providers.mjs';
/**
 * @typedef {Object} TodoTask
 * @property {string|number} id
 * @property {string} title
 * @property {string} status
 * @property {number} [createdAt]
 */


const TODO_STORE_SCHEMA = {
    type: 'object',
    properties: {
        tasks: { type: 'array' }
    }
};

const TODO_STORE_VERSION = '1.0';


/** @type {WeakMap<Map<string|number, any>, {filePath: string|null, hydratedFrom: string|null, persistChain: Promise<void>}>} */
const TODO_STORE_STATE = new WeakMap();


/**
 * @param {{store: Map<string|number, any>, filePath: string|null}} arg0 -
 */
function storeState({ store, filePath }) {
    let state = TODO_STORE_STATE.get(store);
    if (!state) {
        state = { filePath: filePath || null, hydratedFrom: null, persistChain: Promise.resolve() };
        TODO_STORE_STATE.set(store, state);
    } else if (!state.filePath && filePath) {
        state.filePath = filePath;
    }
    return state;
}






/**
 * The todos capability component: task list management exposed as load/save
 * tools and rendered into the system context. Backed by a shared Map store,
 * with optional JSON file persistence.
 * @extends {LoadableComponent}
 */
export class TodoComponent extends LoadableComponent {
    /** @type {Map<string|number, TodoTask>} */
    _store;

    /**
 * @param {{store?: Map<string|number, TodoTask>, filePath?: string|null, eventEmitter?: import('node:events').EventEmitter<Record<string, unknown[]>>|null}} arg0
 */
        constructor({ store, filePath, eventEmitter = null } = {}) {
        super({
            id: CAPABILITY.TODOS,
            loadToolName: LOAD_TODOS_TOOL_NAME,
            saveToolName: MANAGE_TODOS_TOOL_NAME,
            loadDescription: 'Retrieve current task list with statuses.',
            saveDescription: 'Manage tasks. Actions: add, list, update, complete, delete, prune (removes finished tasks older than 7 days).',
            announce: CAPABILITY_REGISTRY[CAPABILITY.TODOS]?.announce ?? null,
            loadParameters: { type: 'object', properties: { _: { type: 'string' } }, required: [] },
            saveParameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['add', 'list', 'update', 'complete', 'delete', 'prune'], description: 'Operation.' },
                    id: { type: 'string', description: 'Task id (required for update/complete/delete).' },
                    title: { type: 'string', description: 'Task title (required for add).' },
                    status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'], description: 'Task status.' }
                },
                required: ['action']
            },
            eventEmitter:  (eventEmitter)
        });
        this._store = store || new Map();
        this._filePath = filePath || null;
        this._storeState = storeState({ store: this._store, filePath: this._filePath });
    }

    
    /**
     * @param {Object} [ctx]
     * @param {boolean} [ctx.preload]
     */
        async shouldInjectStep(ctx = {}) {
        return !!ctx?.preload;
    }

    async stepBlock() {
        return this.load();
    }

    get _nextId() {
        let max = 0;
        for (const k of this._store.keys()) {
            const n = Number(k);
            if (Number.isFinite(n) && n > max) max = n;
        }
        return max + 1;
    }

    
    /**
     * Renders the active task list as a system-context block, or null when
     * the store is empty.
     * @returns {Promise<string|null>}
     */
        async load() {
        await this._hydrate();
        if (this._store.size === 0) return null;
        const all = [...this._store.values()];
        const shown = all.slice(-LIMITS.todo_preload_max_tasks);
        let block = "=== Active Task List ===\n";
        for (const t of shown) {
            const icon = /** @type {Record<string, string>} */ ({ completed: '[x]', in_progress: '[/]', pending: '[ ]', failed: '[!]' })[t.status] || '[ ]';
            block += `${icon} id:${escapePromptField({ value: t.id })} - ${escapePromptField({ value: t.title })} [${escapePromptField({ value: t.status })}]\n`;
        }
        if (all.length > shown.length) {
            block += `... [${all.length - shown.length} older task(s) omitted — use the list action for the full store]\n`;
        }
        block += "========================\n";
        return block;
    }

    
    /**
     * `{ success, ... }` envelope; errors are reported in-band, never thrown.
     * @param {{args?: {action?: string, id?: string|number, title?: string, status?: string}, options?: {runContext?: import('../../core/events.mjs').RunContext|null}}} arg0 -
     * @returns {Promise<Record<string, unknown>>}
     */
        async save({ args = {}, options = {} } = {}) {
        await this._hydrate();
        const rc = options?.runContext ?? null;
        const { action, id: rawId, title, status } = args;
        const id = rawId == null ? rawId
            : (String(rawId).trim() !== '' && Number.isFinite(Number(rawId)) ? Number(rawId) : rawId);
        switch (action) {
            case 'add': {
                if (!title) return { success: false, error: 'title required' };
                const tid = id != null ? id : this._nextId;
                if (this._store.has(tid)) return { success: false, error: `task ${tid} exists` };
                this._store.set(tid, { id: tid, title, status: status || 'pending', createdAt: Date.now() });
                await this._persist();
                this._emit({ name: EVENTS.TODO.CHANGED, payload: { action: 'add', taskId: tid, status: status || 'pending' }, runContext: rc });
                return { success: true, message: `added task ${tid}`, task: this._store.get(tid) };
            }
            case 'list':
                return { success: true, tasks: [...this._store.values()] };
            case 'update': {
                if (id == null) return { success: false, error: 'id required' };
                const t = this._store.get(id);
                if (!t) return { success: false, error: `task ${id} not found` };
                if (title !== undefined) t.title = title;
                if (status !== undefined) t.status = status;
                await this._persist();
                this._emit({ name: EVENTS.TODO.CHANGED, payload: { action: 'update', taskId: id, status: t.status }, runContext: rc });
                return { success: true, message: `updated task ${id}`, task: t };
            }
            case 'complete': {
                if (id == null) return { success: false, error: 'id required' };
                const t = this._store.get(id);
                if (!t) return { success: false, error: `task ${id} not found` };
                t.status = 'completed';
                await this._persist();
                this._emit({ name: EVENTS.TODO.CHANGED, payload: { action: 'complete', taskId: id, status: 'completed' }, runContext: rc });
                return { success: true, message: `completed task ${id}`, task: t };
            }
            case 'delete': {
                if (id == null) return { success: false, error: 'id required' };
                if (!this._store.has(id)) return { success: false, error: `task ${id} not found` };
                this._store.delete(id);
                await this._persist();
                this._emit({ name: EVENTS.TODO.CHANGED, payload: { action: 'delete', taskId: id }, runContext: rc });
                return { success: true, message: `deleted task ${id}` };
            }
            case 'prune': {
                const cutoff = Date.now() - LIMITS.todo_prune_max_age_ms;
                let pruned = 0;
                for (const [tid, t] of [...this._store.entries()]) {
                    const finished = t.status === 'completed' || t.status === 'failed';
                    if (finished && typeof t.createdAt === 'number' && t.createdAt < cutoff) {
                        this._store.delete(tid);
                        pruned++;
                    }
                }
                if (pruned > 0) {
                    await this._persist();
                    this._emit({ name: EVENTS.TODO.CHANGED, payload: { action: 'prune', pruned }, runContext: rc });
                }
                return { success: true, message: `pruned ${pruned} finished task(s)`, pruned };
            }
            default:
                return { success: false, error: `unknown action '${action}'` };
        }
    }

    
    /**
     * Hydrates the shared store from the shared file path, once per store+path.
     * Merges file tasks into the in-memory store (in-memory entries win) instead
     * of skipping when the store is already populated.
     * @returns {Promise<void>}
     */
        async _hydrate() {
        const state = this._storeState;
        const filePath = this._filePath || state.filePath;
        if (!filePath || state.hydratedFrom === filePath) return;
        try {
            const read = await readStoredJson({ filePath, schema: TODO_STORE_SCHEMA, version: TODO_STORE_VERSION });
            if (read.status === 'missing') {
                state.hydratedFrom = filePath;
                return;
            }
            if (read.status === 'corrupt') {
                const reason = read.kind === 'version'
                    ? `has unsupported version ${read.reason}`
                    : `is corrupt (${read.reason})`;
                await quarantineFile({ filePath, reason, onQuarantine: ({ path, ok, error }) => {
                    if (ok) {
                        sdkWarn({ prefix: 'TODOS', args: [`Todo store '${filePath}' ${reason}; quarantined to '${path}' — starting empty.`] });
                    } else {
                        sdkWarn({ prefix: 'TODOS', args: [`Todo store '${filePath}' ${reason}; quarantine failed: ${error?.message} — starting empty.`] });
                    }
                } });
                state.hydratedFrom = filePath;
                return;
            }
            if (Array.isArray(read.value?.tasks)) {
                for (const t of read.value.tasks) {
                    if (t && t.id !== undefined && !this._store.has(t.id)) this._store.set(t.id, t);
                }
            }
            state.hydratedFrom = filePath;
            this._emit({ name: EVENTS.TODO.LOADED, payload: { filePath, taskCount: this._store.size } });
        } catch (err) {
            const e =  (err);
            sdkWarn({ prefix: 'TODOS', args: [`Todo store hydrate failed (${filePath}): ${/** @type {any} */ (e).message}`] });
        }
    }

    
    /**
     * Persists the shared store atomically (tmp + rename) to the shared file
     * path, whichever instance registered it.
     * @returns {Promise<void>}
     */
        async _persist() {
        const state = this._storeState;
        const filePath = this._filePath || state.filePath;
        if (!filePath) return;
        const writeNow = async () => {
            await this._hydrate();
            const data = { version: TODO_STORE_VERSION, updatedAt: Date.now(), tasks: [...this._store.values()] };
            await writeJsonAtomic({ filePath, data });
        };
        const task = state.persistChain.then(writeNow, writeNow);
        state.persistChain = task.then(() => {}, () => {});
        return task;
    }
}
