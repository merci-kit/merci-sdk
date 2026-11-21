// @ts-check


/**
 * @file WorkflowPolicy: lifecycle, live reload, last-known-good, preflight.
 * @version 0.12.0
 *
 * @description
 * One effective state (`config`, prompt text, parsed AST, stat, warnings) is
 * swapped atomically only after a full read, resolve, and template parse. A
 * broken edit keeps the previous state, records `lastError`, and blocks new
 * work through `preflight()` while in-flight renders keep using the last good
 * prompt. The watcher is degraded, never fatal: a watch failure sets
 * `watch: 'failed'` and a warning but not `healthy: false`.
 *
 * Every payload is a stable code, a count, or a file path. Prompt text, hook
 * scripts, provider values, file content, and `err.message` never leave this
 * module; `snapshot()` redacts the config and hashes the prompt.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';

import { PolicyError } from '../../core/errors.mjs';
import { EVENTS, emitEvent } from '../../core/events.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { WORKFLOW_POLICY_DEFAULTS, redactConfig } from './config.mjs';
import { buildEffective, readWorkflowFile } from './file.mjs';
import { parseTemplate, renderFailure, renderParsedTemplate } from './template.mjs';
import { createWorkflowWatcher } from './watch.mjs';

/**
 * @typedef {{ino: number, mtimeMs: number, size: number}} WorkflowFileStat
 * @typedef {Object} EffectivePolicy
 * @property {import('./config.mjs').ResolvedWorkflowConfig} config
 * @property {string} promptTemplate
 * @property {import('./template.mjs').TemplateAst} ast
 * @property {WorkflowFileStat} stat
 * @property {string[]} warnings
 * @property {number} loadedAt
 * @typedef {{reasons: string[], at: number}} PolicyFailure
 * @typedef {{changed: boolean, healthy: boolean, reasons: string[]}} ReloadResult
 * @typedef {'active'|'disabled'|'failed'|'stopped'} WatchState
 * @typedef {Object} WorkflowPolicyOptions
 * @property {string} [path]
 * @property {boolean} [watch]
 * @property {number} [debounceMs]
 * @property {Record<string, string|undefined>} [env]
 * @property {number} [maxFileBytes]
 * @property {number} [maxTemplateDepth]
 * @property {number} [maxRenderedChars]
 * @property {() => number} [now]
 * @property {import('node:events').EventEmitter|null} [eventEmitter]
 * @property {import('./watch.mjs').WorkflowWatchFactory|null} [watchImpl]
 */

/**
 * @param {{reason: string}} arg0
 * @returns {PolicyError}
 */
function lifecycleError({ reason }) {
    const message = reason === 'stopped'
        ? 'Workflow policy is stopped'
        : reason === 'not_started'
            ? 'Workflow policy is not started'
            : 'Workflow policy is already started';
    return new PolicyError({ message, options: { reason } });
}

/**
 * @param {{name: string}} arg0
 * @returns {PolicyError}
 */
function invalidOption({ name }) {
    return new PolicyError({
        message: 'Workflow policy option is invalid',
        options: { reason: `invalid_option:${name}` }
    });
}

/**
 * @param {{name: string, value: unknown, min: number, max?: number}} arg0
 * @returns {number}
 */
function readNumberOption({ name, value, min, max = Number.MAX_SAFE_INTEGER }) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw invalidOption({ name });
    }
    return value;
}

/**
 * @param {{text: string}} arg0
 * @returns {string}
 */
function sha256({ text }) {
    return createHash('sha256').update(text).digest('hex');
}

/**
 * @param {{left: WorkflowFileStat, right: WorkflowFileStat}} arg0
 * @returns {boolean}
 */
function isSameStat({ left, right }) {
    return left.ino === right.ino && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

/**
 * A reload is single-flight, keeps the last good state on failure, and arms a
 * debounced watcher only after the first load succeeds.
 *
 * `stop()` is final: it may be called before `start()`, and nothing emits after
 * it. A `reload()` in flight when `stop()` lands returns `reasons: ['stopped']`
 * without swapping or emitting.
 */
export class WorkflowPolicy {
    /** @type {string} */
    #path;
    /** @type {boolean} */
    #watch;
    /** @type {number} */
    #debounceMs;
    /** @type {Record<string, string|undefined>} */
    #env;
    /** @type {number} */
    #maxFileBytes;
    /** @type {number} */
    #maxTemplateDepth;
    /** @type {number} */
    #maxRenderedChars;
    /** @type {() => number} */
    #now;
    /** @type {import('node:events').EventEmitter|null} */
    #eventEmitter;
    /** @type {import('./watch.mjs').WorkflowWatchFactory|null} */
    #watchImpl;
    /** @type {EffectivePolicy|null} */
    #effective = null;
    /** @type {PolicyFailure|null} */
    #lastError = null;
    #started = false;
    #stopped = false;
    /** @type {Promise<ReloadResult>|null} */
    #reloading = null;
    /** @type {{close: () => void}|null} */
    #watcher = null;
    /** @type {WatchState} */
    #watchState = 'disabled';
    /** @type {'startup'|'reload'|null} */
    #source = null;
    /** @type {number|null} */
    #lastCheckedAt = null;
    /** @type {string|null} */
    #contentHash = null;

    /** @param {WorkflowPolicyOptions} [arg0] */
    constructor({
        path = WORKFLOW_POLICY_DEFAULTS.path,
        watch = WORKFLOW_POLICY_DEFAULTS.watch,
        debounceMs = WORKFLOW_POLICY_DEFAULTS.debounceMs,
        env = process.env,
        maxFileBytes = WORKFLOW_POLICY_DEFAULTS.maxFileBytes,
        maxTemplateDepth = WORKFLOW_POLICY_DEFAULTS.maxTemplateDepth,
        maxRenderedChars = WORKFLOW_POLICY_DEFAULTS.maxRenderedChars,
        now = Date.now,
        eventEmitter = null,
        watchImpl = null
    } = {}) {
        if (typeof path !== 'string' || path.trim() === '') throw invalidOption({ name: 'path' });
        if (typeof watch !== 'boolean') throw invalidOption({ name: 'watch' });
        if (typeof env !== 'object' || env === null || Array.isArray(env)) throw invalidOption({ name: 'env' });
        if (typeof now !== 'function') throw invalidOption({ name: 'now' });
        if (eventEmitter !== null && (typeof eventEmitter !== 'object' || typeof eventEmitter.emit !== 'function')) {
            throw invalidOption({ name: 'eventEmitter' });
        }
        if (watchImpl !== null && typeof watchImpl !== 'function') throw invalidOption({ name: 'watchImpl' });

        this.#path = resolve(path);
        this.#watch = watch;
        this.#debounceMs = readNumberOption({ name: 'debounceMs', value: debounceMs, min: 0 });
        this.#env = env;
        this.#maxFileBytes = readNumberOption({ name: 'maxFileBytes', value: maxFileBytes, min: 1 });
        this.#maxTemplateDepth = readNumberOption({
            name: 'maxTemplateDepth',
            value: maxTemplateDepth,
            min: 1,
            max: LIMITS.workflow_template_depth_ceiling
        });
        this.#maxRenderedChars = readNumberOption({ name: 'maxRenderedChars', value: maxRenderedChars, min: 1 });
        this.#now = now;
        this.#eventEmitter = eventEmitter;
        this.#watchImpl = watchImpl;
    }

    /**
     * Loads the file and arms the watcher. A load failure emits `load_failed`
     * and rethrows, leaving `started` false so the host can retry after a fix.
     * @returns {Promise<void>}
     */
    async start() {
        // `stop()` is final, so it outranks the already-started check.
        if (this.#stopped) throw lifecycleError({ reason: 'stopped' });
        if (this.#started) throw lifecycleError({ reason: 'already_started' });
        this.#started = true;
        try {
            await this.reload({ source: 'startup', throwOnError: true });
        } catch (err) {
            this.#started = false;
            throw err;
        }
        if (this.#stopped) {
            // A stop during the load wins: the attempt did not start.
            this.#started = false;
            return;
        }
        this.#armWatcher();
    }

    /**
     * Re-reads the file. A concurrent call joins the in-flight reload instead of
     * queueing a second read. An unchanged stat (or, with `force`, an unchanged
     * content hash) is a no-op; a failure keeps the last good state.
     * @param {{source?: 'startup'|'reload', throwOnError?: boolean, force?: boolean}} [arg0]
     * @returns {Promise<ReloadResult>}
     */
    async reload({ source = 'reload', throwOnError = false, force = false } = {}) {
        if (this.#stopped) throw lifecycleError({ reason: 'stopped' });
        if (!this.#started) throw lifecycleError({ reason: 'not_started' });
        if (this.#reloading !== null) return this.#reloading;
        const inflight = this.#doReload({ source, throwOnError, force });
        this.#reloading = inflight;
        try {
            return await inflight;
        } finally {
            this.#reloading = null;
        }
    }

    /**
     * Closes the watcher and clears its timer. Idempotent, and valid before
     * `start()`. The effective state stays readable for `renderPrompt()`.
     */
    stop() {
        if (this.#stopped) return;
        this.#stopped = true;
        this.#watchState = 'stopped';
        const watcher = this.#watcher;
        this.#watcher = null;
        if (watcher !== null) watcher.close();
    }

    /** @returns {import('./config.mjs').ResolvedWorkflowConfig|null} */
    getConfig() {
        return this.#effective === null ? null : this.#effective.config;
    }

    /**
     * The sink this policy emits to. A facade records it before pointing an
     * injected policy at its own emitter, and restores it on `stop()` (F1-6).
     * @returns {import('node:events').EventEmitter|null}
     */
    get eventEmitter() {
        return this.#eventEmitter;
    }

    /**
     * Point this policy's events at one sink. The facade uses it for an
     * injected policy so `workflow_policy:*` reaches the same ring as every
     * other namespace; the constructor is the usual way to set it.
     * @param {{eventEmitter: import('node:events').EventEmitter|null}} arg0 -
     * @returns {this}
     */
    withEventEmitter({ eventEmitter }) {
        if (eventEmitter !== null && (typeof eventEmitter !== 'object' || typeof eventEmitter.emit !== 'function')) {
            throw invalidOption({ name: 'eventEmitter' });
        }
        this.#eventEmitter = eventEmitter;
        return this;
    }

    /**
     * Renders the stored AST for one item. Before a successful start this is
     * `not_started`; a render failure emits `render_failed` and rethrows.
     * @param {{issue?: unknown, attempt?: unknown}} [arg0]
     * @returns {string}
     */
    renderPrompt({ issue, attempt = null } = {}) {
        const effective = this.#effective;
        if (effective === null) throw lifecycleError({ reason: 'not_started' });
        // An empty body still gets a prompt; the `empty_prompt` warning says why.
        if (effective.promptTemplate === '') return WORKFLOW_POLICY_DEFAULTS.promptFallback;
        try {
            return renderParsedTemplate({
                ast: effective.ast,
                issue,
                attempt,
                maxRenderedChars: this.#maxRenderedChars
            });
        } catch (err) {
            const { error, reason } = renderFailure({ err });
            this.#emit({
                name: EVENTS.WORKFLOW_POLICY.RENDER_FAILED,
                payload: { reason, field: error.field }
            });
            throw error;
        }
    }

    /** @returns {string[]} Reasons that block new work; `[]` means healthy. */
    preflight() {
        if (this.#stopped) return ['stopped'];
        if (!this.#started || this.#effective === null) return ['not_started'];
        if (this.#lastError !== null) return [...this.#lastError.reasons];
        return [];
    }

    /**
     * The operator-safe view: no prompt text, hook scripts, provider values, or
     * error messages. Stable before the first successful start.
     * @returns {Record<string, unknown>}
     */
    snapshot() {
        const effective = this.#effective;
        return {
            started: this.#started,
            stopped: this.#stopped,
            healthy: this.#lastError === null,
            path: this.#path,
            loadedAt: effective === null ? null : effective.loadedAt,
            lastCheckedAt: this.#lastCheckedAt,
            source: this.#source,
            watch: this.#watchState,
            prompt: effective === null
                ? null
                : { chars: effective.promptTemplate.length, hash: sha256({ text: effective.promptTemplate }).slice(0, LIMITS.policy_hash_chars) },
            config: effective === null ? null : redactConfig({ config: effective.config }),
            warnings: effective === null ? [] : [...effective.warnings],
            lastError: this.#lastError === null
                ? null
                : { reasons: [...this.#lastError.reasons], at: this.#lastError.at }
        };
    }

    /**
     * @param {{source: 'startup'|'reload', throwOnError: boolean, force: boolean}} arg0
     * @returns {Promise<ReloadResult>}
     */
    async #doReload({ source, throwOnError, force }) {
        /** @type {{text: string, stat: WorkflowFileStat}|null} */
        let read = null;
        // A write between stat and read is retried, then the latest read wins and
        // a following watch event corrects it.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            this.#lastCheckedAt = this.#now();
            try {
                read = await readWorkflowFile({ path: this.#path, maxFileBytes: this.#maxFileBytes });
            } catch (err) {
                return this.#fail({ source, throwOnError, err });
            }
            if (this.#stopped) return this.#stoppedResult();
            /** @type {import('node:fs').Stats|null} */
            let after = null;
            try {
                after = await fs.stat(this.#path);
            } catch { /* vanished or unreadable; the read is still a snapshot */ }
            if (this.#stopped) return this.#stoppedResult();
            if (after === null) break;
            const stat = { ino: after.ino, mtimeMs: after.mtimeMs, size: after.size };
            if (isSameStat({ left: stat, right: read.stat })) break;
            read = { text: read.text, stat };
        }
        if (read === null) return this.#unchangedResult();

        const effective = this.#effective;
        /** @type {string|null} */
        let hash = null;
        if (!force && effective !== null && isSameStat({ left: read.stat, right: effective.stat })) {
            if (this.#lastError === null) return this.#unchangedResult();
            // A stat match is not content proof: a same-length rewrite can
            // restore ino/size/mtime. Only the last validated content may clear
            // a stored failure (W2D-5); any other text takes the real parse.
            hash = sha256({ text: read.text });
            if (hash === this.#contentHash) return this.#healUnchanged({ source });
        }
        hash ??= sha256({ text: read.text });
        if (force && effective !== null && hash === this.#contentHash) {
            // Adopt the fresh stat so the next plain reload no-ops instead of re-parsing.
            this.#effective = { ...effective, stat: read.stat };
            return this.#healUnchanged({ source });
        }

        /** @type {EffectivePolicy} */
        let next;
        try {
            const { config, promptTemplate, warnings } = buildEffective({
                markdown: read.text,
                path: this.#path,
                env: this.#env
            });
            // A failed watcher is sticky: this rebuild would otherwise drop the warning
            // while `watch` stays 'failed'.
            if (this.#watchState === 'failed' && !warnings.includes('watch_failed')) {
                warnings.push('watch_failed');
            }
            const ast = parseTemplate({ template: promptTemplate, maxDepth: this.#maxTemplateDepth });
            next = { config, promptTemplate, ast, stat: read.stat, warnings, loadedAt: this.#now() };
        } catch (err) {
            return this.#fail({ source, throwOnError, err });
        }

        this.#effective = next;
        this.#contentHash = hash;
        this.#lastError = null;
        this.#source = source;
        const promptChars = next.promptTemplate.length;
        if (source === 'startup') {
            this.#emit({
                name: EVENTS.WORKFLOW_POLICY.LOADED,
                payload: { path: this.#path, source: 'startup', promptChars, warnings: [...next.warnings] }
            });
        } else {
            this.#emit({
                name: EVENTS.WORKFLOW_POLICY.RELOADED,
                payload: { path: this.#path, promptChars, changed: true }
            });
        }
        return { changed: true, healthy: true, reasons: [] };
    }

    /**
     * @param {{source: 'startup'|'reload', throwOnError: boolean, err: unknown}} arg0
     * @returns {ReloadResult}
     */
    #fail({ source, throwOnError, err }) {
        // `stop()` outranks a read or parse failure that lands after it: no state, no event.
        if (this.#stopped) return this.#stoppedResult();
        const error = err instanceof PolicyError
            ? err
            : new PolicyError({
                message: 'Workflow file could not be reloaded',
                options: { reason: 'workflow_read_error', path: this.#path }
            });
        const reasons = [...error.reasons];
        this.#lastError = { reasons, at: this.#now() };
        this.#lastCheckedAt = this.#now();
        this.#emit({
            name: source === 'startup' ? EVENTS.WORKFLOW_POLICY.LOAD_FAILED : EVENTS.WORKFLOW_POLICY.RELOAD_FAILED,
            // A copy: a listener must not be able to mutate `preflight()` state.
            payload: { path: this.#path, reasons: [...reasons] }
        });
        if (throwOnError) throw error;
        return { changed: false, healthy: false, reasons: [...reasons] };
    }

    /**
     * The content hash matches the last validated text, so the bytes are
     * exactly the last good state and no re-parse is needed. A stored failure
     * is stale by definition here: the file that failed to read now reads as
     * what loaded, which is how a transient `EACCES`/`EIO` or a
     * move-and-restore heals without an edit (F1-1).
     * @param {{source: 'startup'|'reload'}} arg0
     * @returns {ReloadResult}
     */
    #healUnchanged({ source }) {
        if (this.#lastError === null) return this.#unchangedResult();
        this.#lastError = null;
        this.#source = source;
        this.#emit({
            name: EVENTS.WORKFLOW_POLICY.RELOADED,
            payload: { path: this.#path, changed: false }
        });
        return { changed: false, healthy: true, reasons: [] };
    }

    /** @returns {ReloadResult} */
    #unchangedResult() {
        return {
            changed: false,
            healthy: this.#lastError === null,
            reasons: this.#lastError === null ? [] : [...this.#lastError.reasons]
        };
    }

    /** @returns {ReloadResult} */
    #stoppedResult() {
        return { changed: false, healthy: false, reasons: ['stopped'] };
    }

    /** Arms the watcher; a construction failure degrades the policy, not the load. */
    #armWatcher() {
        if (!this.#watch) {
            this.#watchState = 'disabled';
            return;
        }
        try {
            this.#watcher = createWorkflowWatcher({
                path: this.#path,
                debounceMs: this.#debounceMs,
                onEvent: (event) => this.#onWatchEvent({ event }),
                ...(this.#watchImpl === null ? {} : { watchImpl: this.#watchImpl })
            });
            this.#watchState = 'active';
        } catch {
            this.#watchState = 'failed';
            this.#recordWarning({ code: 'watch_failed' });
            this.#emit({
                name: EVENTS.WORKFLOW_POLICY.WATCH_FAILED,
                payload: { path: this.#path, reason: 'watch_failed' }
            });
        }
    }

    /** @param {{event: import('./watch.mjs').WorkflowWatchEvent}} arg0 */
    #onWatchEvent({ event }) {
        if (this.#stopped) return;
        if (event.type === 'change') {
            void this.reload().catch(() => {});
            return;
        }
        this.#watchState = 'failed';
        this.#recordWarning({ code: 'watch_failed' });
        this.#emit({
            name: EVENTS.WORKFLOW_POLICY.WATCH_FAILED,
            payload: { path: this.#path, reason: event.reason }
        });
    }

    /** @param {{code: string}} arg0 */
    #recordWarning({ code }) {
        const effective = this.#effective;
        if (effective === null || effective.warnings.includes(code)) return;
        this.#effective = { ...effective, warnings: [...effective.warnings, code] };
    }

    /**
     * The one emit point; a stopped policy never emits.
     * @param {{name: string, payload: Record<string, unknown>}} arg0
     */
    #emit({ name, payload }) {
        if (this.#stopped) return;
        emitEvent({ emitter: this.#eventEmitter, name, payload });
    }
}
