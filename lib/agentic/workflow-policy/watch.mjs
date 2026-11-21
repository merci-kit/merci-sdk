// @ts-check


/**
 * @file Debounced `fs.watch` wrapper for the workflow file.
 * @version 0.12.0
 *
 * @description
 * The containing directory is watched, not the file: an editor that writes a
 * temp file and renames it over `WORKFLOW.md` replaces the inode, and a watch
 * on the old inode would miss every later edit. `change` and `rename` both
 * count, because an atomic save arrives as `rename` on macOS. A burst becomes
 * one `change` callback after `debounceMs`, and a watcher `'error'` is reported
 * once as the stable code `watch_failed` (never the system message, which can
 * name a host path) with no re-arm; a later change still triggers one reload.
 */
import { watch } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { LIMITS } from '../../core/limit-config.mjs';

/**
 * @typedef {Object} WorkflowWatchHandle
 * @property {(event: string, listener: (...args: unknown[]) => void) => unknown} on
 * @property {() => void} close
 * @property {(() => unknown)|undefined} [unref]
 */

/** `watchImpl` is injectable so tests can drive the debounce without the filesystem. */
/**
 * @typedef {(directory: string) => WorkflowWatchHandle} WorkflowWatchFactory
 */

/**
 * @typedef {{type: 'change'}|{type: 'error', reason: string}} WorkflowWatchEvent
 */

/**
 * @param {{path?: string, debounceMs?: number, onEvent?: (event: WorkflowWatchEvent) => void, watchImpl?: WorkflowWatchFactory}} [arg0]
 * @returns {{close: () => void}}
 */
export function createWorkflowWatcher({
    path = 'WORKFLOW.md',
    debounceMs = LIMITS.workflow_debounce_ms,
    onEvent = () => {},
    watchImpl = watch
} = {}) {
    const target = resolve(path);
    const filename = basename(target);
    let closed = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;

    const watcher = watchImpl(dirname(target));
    // A forgotten close() must not keep the host process alive.
    if (typeof watcher.unref === 'function') watcher.unref();

    /** Reports a watcher failure once; a throwing consumer must never crash the host. */
    const reportFailure = () => {
        try {
            onEvent({ type: 'error', reason: 'watch_failed' });
        } catch { /* a watcher failure must never crash the host */ }
    };

    /** @type {(...args: unknown[]) => void} */
    const onChange = (...args) => {
        if (closed) return;
        // Some platforms omit the filename; then every event in this directory counts.
        const changed = args[1];
        const name = changed === null || changed === undefined ? null : String(changed);
        if (name !== null && name !== filename) return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            // Contained like the error path: a throwing consumer becomes `watch_failed`.
            try {
                onEvent({ type: 'change' });
            } catch {
                reportFailure();
            }
        }, debounceMs);
        if (typeof timer.unref === 'function') timer.unref();
    };

    watcher.on('change', onChange);
    watcher.on('rename', onChange);
    watcher.on('error', () => {
        if (closed) return;
        // State becomes 'failed' and the watcher is not re-armed; a later change
        // still triggers one reload.
        reportFailure();
    });

    return {
        close() {
            if (closed) return;
            closed = true;
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            try {
                watcher.close();
            } catch { /* close is best effort */ }
        }
    };
}
