// @ts-check


/**
 * @file Lifecycle hooks for per-item workspaces.
 * @version 0.12.0
 *
 * @description
 * Hooks are trusted host configuration: a shell script supplied to the
 * `WorkspaceManager` constructor, never read from the workspace, `AGENTS.md`,
 * or repo content. Each hook runs with the workspace as `cwd`, gets the safe
 * child environment plus the `MERCI_*` workspace variables, and is bounded by
 * `timeoutMs`. Events carry identifiers and timings only — never the script
 * text and never stderr, which stays on the thrown error as a truncated tail.
 */
import { EVENTS, emitEvent } from '../../core/events.mjs';
import { ConfigurationError, WorkspaceError, isAbortErrorSafe as isAbortError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { runCommand, RUN_COMMAND_TIMEOUT_CODE } from '../../support/run-command.mjs';
import { normalizeIdentifier } from './identity.mjs';

/**
 * A hook script that exits non-zero is fatal to `ensure`/`beforeRun`;
 * `afterRun`/`beforeRemove` failures are logged and ignored.
 * @type {ReadonlySet<string>}
 */
const FATAL_HOOKS = new Set(['afterCreate', 'beforeRun']);

/** The four lifecycle hooks, in call order. */
export const WORKSPACE_HOOKS = Object.freeze({
    AFTER_CREATE: 'afterCreate',
    BEFORE_RUN: 'beforeRun',
    AFTER_RUN: 'afterRun',
    BEFORE_REMOVE: 'beforeRemove'
});

/**
 * The minimum an event sink must provide; a `MerciEventEmitter` and a plain
 * `{ emit }` object both qualify.
 * @typedef {Object} WorkspaceEmitter
 * @property {(arg0: string, arg1: Record<string, unknown>) => void} emit
 */

/**
 * The identity fields a hook runs with.
 * @typedef {Object} WorkspaceHookTarget
 * @property {string|number} workItemId
 * @property {string|null} [identifier]
 * @property {string} key
 * @property {string} path
 */

/**
 * Validated hook configuration.
 * @typedef {Object} NormalizedHooks
 * @property {string|null} afterCreate
 * @property {string|null} beforeRun
 * @property {string|null} afterRun
 * @property {string|null} beforeRemove
 * @property {number} timeoutMs
 * @property {Record<string, string>} env
 */

/**
 * Emit one `workspace:*` event on a sink that may be a bare `{ emit }` object.
 * Tagged events: the `EVENTS` constants are the only names used.
 * @param {{eventEmitter: WorkspaceEmitter|null, name: string, payload: Record<string, unknown>}} arg0 -
 * @returns {void}
 */
export function emitWorkspaceEvent({ eventEmitter, name, payload }) {
    if (!eventEmitter) return;
    emitEvent({ emitter: /** @type {import('node:events').EventEmitter} */ (eventEmitter), name, payload });
}

/**
 * True when the error is a caller abort, not a hook failure. A caller abort is
 * the one thing `afterRun`/`remove` may still throw. The rule (and its
 * hostile-getter guard) is the canonical `core/errors.mjs` one; re-exported so
 * this module's surface is unchanged.
 */
export { isAbortError };

/**
 * @param {{name: string}} arg0 -
 * @returns {ConfigurationError}
 */
const invalidScript = ({ name }) => new ConfigurationError({
    message: `hooks.${name} must be a string or null.`,
    options: { option: `hooks.${name}` }
});

/**
 * Normalize and validate the `hooks` constructor option.
 *
 * Scripts are `string | null`; `timeoutMs` must be a positive integer. `env` is
 * merged over the safe child environment, so a value must be a string.
 *
 * @param {{hooks?: unknown}} arg0 -
 * @returns {NormalizedHooks}
 * @throws {ConfigurationError} When a script, the timeout, or an env value is invalid.
 */
export function normalizeHooks({ hooks = {} } = {}) {
    if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
        throw new ConfigurationError({ message: 'hooks must be an object.', options: { option: 'hooks' } });
    }
    const source = /** @type {Record<string, unknown>} */ (hooks);

    /**
     * @param {{name: string}} arg0 -
     * @returns {string|null}
     */
    const script = ({ name }) => {
        const value = source[name];
        if (value === undefined || value === null) return null;
        if (typeof value !== 'string') throw invalidScript({ name });
        return value;
    };

    const timeoutMs = source.timeoutMs ?? LIMITS.workspace_hook_timeout_ms;
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new ConfigurationError({
            message: 'hooks.timeoutMs must be a positive integer.',
            options: { option: 'hooks.timeoutMs' }
        });
    }

    const rawEnv = source.env ?? {};
    if (rawEnv === null || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
        throw new ConfigurationError({ message: 'hooks.env must be an object.', options: { option: 'hooks.env' } });
    }
    /** @type {Record<string, string>} */
    const env = {};
    for (const [name, value] of Object.entries(rawEnv)) {
        if (typeof value !== 'string') {
            throw new ConfigurationError({
                message: `hooks.env.${name} must be a string.`,
                options: { option: `hooks.env.${name}` }
            });
        }
        env[name] = value;
    }

    return Object.freeze({
        afterCreate: script({ name: WORKSPACE_HOOKS.AFTER_CREATE }),
        beforeRun: script({ name: WORKSPACE_HOOKS.BEFORE_RUN }),
        afterRun: script({ name: WORKSPACE_HOOKS.AFTER_RUN }),
        beforeRemove: script({ name: WORKSPACE_HOOKS.BEFORE_REMOVE }),
        timeoutMs,
        env: Object.freeze(env)
    });
}

/**
 * Run one lifecycle hook, emitting start/finish/failure around it.
 *
 * A null script is a no-op. A non-zero exit or an internal timeout throws a
 * `WorkspaceError` (`hook_failed` / `hook_timeout`) carrying a truncated
 * `stderrTail`; a caller abort is rethrown unchanged.
 *
 * AC5 correction to plan §3.5's spread order: `hooks.env` is merged **first**,
 * so the manager-computed `MERCI_WORKSPACE`, `MERCI_WORKSPACE_KEY`, and
 * `MERCI_WORK_ITEM_ID` always win. A host-supplied env cannot shadow the
 * identity a hook is told to trust.
 *
 * @param {{hook: string, script: string|null, workspace: WorkspaceHookTarget, timeoutMs: number, env?: Record<string, string>, signal?: AbortSignal|null, eventEmitter?: WorkspaceEmitter|null}} arg0 -
 * @returns {Promise<void>}
 * @throws {WorkspaceError} `hook_failed` or `hook_timeout`.
 */
export async function runWorkspaceHook({ hook, script, workspace, timeoutMs, env = {}, signal = null, eventEmitter = null }) {
    if (script === null) return;
    /** @type {WorkspaceEmitter|null} */
    const sink = eventEmitter;
    const identifier = normalizeIdentifier({ value: workspace.identifier });
    emitWorkspaceEvent({
        eventEmitter: sink,
        name: EVENTS.WORKSPACE.HOOK_STARTED,
        payload: {
            workItemId: workspace.workItemId,
            ...(identifier === null ? {} : { identifier }),
            key: workspace.key,
            path: workspace.path,
            hook
        }
    });

    const fatal = FATAL_HOOKS.has(hook);
    const startedAt = Date.now();
    const windows = process.platform === 'win32';
    // AC5 correction: the manager-computed identity wins over `hooks.env`, so a
    // host-supplied env cannot shadow MERCI_WORKSPACE* with a lie the hook trusts.
    const hookEnv = {
        ...env,
        MERCI_WORKSPACE: workspace.path,
        MERCI_WORKSPACE_KEY: workspace.key,
        MERCI_WORK_ITEM_ID: String(workspace.workItemId)
    };

    /**
     * @param {{timedOut: boolean, exitCode: number|null}} arg0 -
     * @returns {void}
     */
    const emitFailed = ({ timedOut, exitCode }) => {
        emitWorkspaceEvent({
            eventEmitter: sink,
            name: EVENTS.WORKSPACE.HOOK_FAILED,
            payload: {
                workItemId: workspace.workItemId,
                ...(identifier === null ? {} : { identifier }),
                key: workspace.key,
                hook,
                durationMs: Date.now() - startedAt,
                exitCode,
                timedOut,
                fatal
            }
        });
        // stderr is deliberately not part of the event; it only rides the error.
    };

    /** @type {{code: number|null, stdout: string, stderr: string, truncated?: boolean}} */
    let result;
    try {
        result = await runCommand({
            command: windows ? (process.env.ComSpec ?? 'cmd.exe') : 'sh',
            args: windows ? ['/d', '/s', '/c', script] : ['-c', script],
            cwd: workspace.path,
            env: hookEnv,
            timeoutMs,
            signal
        });
    } catch (error) {
        if (isAbortError({ error })) throw error;
        const timedOut = /** @type {{code?: string}} */ (error).code === RUN_COMMAND_TIMEOUT_CODE;
        emitFailed({ timedOut, exitCode: null });
        throw new WorkspaceError({
            message: `Workspace hook '${hook}' ${timedOut ? 'timed out' : 'failed'} for ${workspace.path}.`,
            options: { reason: timedOut ? 'hook_timeout' : 'hook_failed', workItemId: workspace.workItemId, path: workspace.path, cause: error }
        });
    }

    if (result.code !== 0) {
        emitFailed({ timedOut: false, exitCode: result.code });
        throw new WorkspaceError({
            message: `Workspace hook '${hook}' exited with code ${String(result.code)} for ${workspace.path}.`,
            options: {
                // A chatty hook is capped, not killed (F2-9): the real exit code
                // is kept, and the cap is named instead of blamed on the script.
                reason: result.truncated === true ? 'hook_output_limit' : 'hook_failed',
                workItemId: workspace.workItemId,
                path: workspace.path,
                stderrTail: result.stderr
            }
        });
    }

    emitWorkspaceEvent({
        eventEmitter: sink,
        name: EVENTS.WORKSPACE.HOOK_FINISHED,
        payload: {
            workItemId: workspace.workItemId,
            ...(identifier === null ? {} : { identifier }),
            key: workspace.key,
            hook,
            durationMs: Date.now() - startedAt,
            exitCode: result.code
        }
    });
}
