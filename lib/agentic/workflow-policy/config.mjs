// @ts-check


/**
 * @file Strict `WORKFLOW.md` config resolution: defaults, validation, env/path
 * expansion, and the operator-safe projection.
 * @version 0.12.0
 *
 * @description
 * The front matter is inert YAML; this module is the only place that turns it
 * into a typed object. Every field is read explicitly (never `Object.assign`
 * over an untrusted map), every error is collected so one edit reports all of
 * them, and the result is deep-frozen with `Object.prototype`.
 *
 * Path-like extension keys live under `merci.*` so the core keys stay
 * Symphony-compatible. `tracker.provider` expands only a whole-value `$VAR` /
 * `${VAR}`; the shell owns hook expansion, so hooks are verbatim.
 */
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PolicyError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { isObjectLike, isPlainObject } from '../../support/validation.mjs';

/**
 * The loader defaults pinned by §3.8; the resolved config defaults are in `resolveWorkflowConfig`.
 * Numeric fields are read from `LIMITS` on each access, so an override applies
 * without rebuilding this object; the shape stays an enumerable frozen object.
 */
/** @type {Readonly<{path: string, watch: boolean, debounceMs: number, maxFileBytes: number, maxTemplateDepth: number, maxRenderedChars: number, promptFallback: string}>} */
export const WORKFLOW_POLICY_DEFAULTS = /** @type {any} */ (Object.freeze(Object.defineProperties({}, {
    path: { value: 'WORKFLOW.md', enumerable: true },
    watch: { value: true, enumerable: true },
    debounceMs: { get: () => LIMITS.workflow_debounce_ms, enumerable: true },
    maxFileBytes: { get: () => LIMITS.workflow_max_file_bytes, enumerable: true },
    maxTemplateDepth: { get: () => LIMITS.workflow_max_template_depth, enumerable: true },
    maxRenderedChars: { get: () => LIMITS.workflow_max_rendered_chars, enumerable: true },
    promptFallback: { value: 'You are working on an issue from the configured tracker.', enumerable: true }
})));

/** Every error reason this slice can emit; `reasons` entries are `<code>` or `<code>:<detail>`. */
export const WORKFLOW_POLICY_REASONS = Object.freeze([
    'missing_workflow_file',
    'workflow_read_error',
    'workflow_too_large',
    'workflow_parse_error',
    'workflow_front_matter_not_a_map',
    'invalid_config',
    'invalid_option',
    'missing_env',
    'template_parse_error',
    'template_render_error',
    'not_started',
    'already_started',
    'stopped'
]);

/** Every warning code this slice can emit. */
export const WORKFLOW_POLICY_WARNINGS = Object.freeze([
    'unknown_key',
    'unsupported_section',
    'invalid_by_state',
    'empty_prompt',
    'no_active_states',
    'watch_failed'
]);

/**
 * @typedef {Object} ResolvedTracker
 * @property {string|null} kind
 * @property {Record<string, unknown>} provider
 * @property {string[]} requiredLabels
 * @property {string[]} activeStates
 * @property {string[]} terminalStates
 */

/** @typedef {{intervalMs: number}} ResolvedPolling */

/**
 * @typedef {Object} ResolvedWorkspace
 * @property {string} root
 * @property {'directory'|'git-worktree'} strategy
 * @property {string|null} repoRoot
 * @property {string} baseRef
 * @property {string} branchPrefix
 */

/**
 * @typedef {Object} ResolvedHooks
 * @property {string|null} afterCreate
 * @property {string|null} beforeRun
 * @property {string|null} afterRun
 * @property {string|null} beforeRemove
 * @property {number} timeoutMs
 */

/**
 * @typedef {Object} ResolvedAgent
 * @property {number} maxConcurrentAgents
 * @property {number} maxTurns
 * @property {number} maxRetryBackoffMs
 * @property {Record<string, number>} maxConcurrentAgentsByState
 */

/**
 * @typedef {Object} ResolvedScheduler
 * @property {number} maxAttemptsPerItem
 * @property {number} continuationMax
 * @property {number} continuationDelayMs
 * @property {number} stallTimeoutMs
 * @property {number} retryBaseMs
 * @property {number|null} maxTotalTokens
 * @property {number|null} maxTotalUsd
 * @property {number|null} maxDispatches
 */

/**
 * @typedef {Object} ResolvedEngine
 * @property {'agentic'|'dag'|'stateMachine'|'discussion'} kind
 * @property {string|null} model
 */

/**
 * @typedef {Object} ResolvedWorkflowConfig
 * @property {ResolvedTracker} tracker
 * @property {ResolvedPolling} polling
 * @property {ResolvedWorkspace} workspace
 * @property {ResolvedHooks} hooks
 * @property {ResolvedAgent} agent
 * @property {ResolvedScheduler} scheduler
 * @property {ResolvedEngine} engine
 */

/** Keys that must never be read from or written to an untrusted map. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Known keys per file section; anything else inside a known section warns. */
const TRACKER_KEYS = ['kind', 'provider', 'required_labels', 'active_states', 'terminal_states'];
const POLLING_KEYS = ['interval_ms'];
const WORKSPACE_KEYS = ['root'];
const AGENT_KEYS = ['max_concurrent_agents', 'max_turns', 'max_retry_backoff_ms', 'max_concurrent_agents_by_state'];
const HOOKS_KEYS = ['after_create', 'before_run', 'after_run', 'before_remove', 'timeout_ms'];
const MERCI_WORKSPACE_KEYS = ['strategy', 'repo_root', 'base_ref', 'branch_prefix'];
const MERCI_SCHEDULER_KEYS = ['max_attempts_per_item', 'retry_base_ms', 'continuation_delay_ms', 'continuation_max',
    'stall_timeout_ms', 'max_total_tokens', 'max_total_usd', 'max_dispatches'];
const MERCI_ENGINE_KEYS = ['kind', 'model'];
const TOP_LEVEL_KEYS = ['tracker', 'polling', 'workspace', 'agent', 'hooks', 'merci'];

/** Embedded path references: `$NAME` or `${NAME}`; a lone `$` stays literal. */
const EMBEDDED_ENV_REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** `tracker.provider` leaves expand only when the whole value is a reference. */
const EXACT_ENV_REF = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;

/**
 * @param {{base: string, key: string}} arg0
 * @returns {string}
 */
function joinPath({ base, key }) {
    return base === '' ? key : `${base}.${key}`;
}

/**
 * @param {{errors: string[], reason: string}} arg0
 */
function addError({ errors, reason }) {
    // One field can be reached twice (e.g. repo_root's own type check and the
    // git-worktree requirement); the reason list stays a set so N is honest.
    if (!errors.includes(reason)) errors.push(reason);
}

/**
 * Walks the untrusted input once and reports every forbidden key, so a nested
 * `__proto__` cannot reach a field read. A seen set also bounds cycles.
 * @param {{value: unknown, path: string, errors: string[], seen: Set<unknown>}} arg0
 */
function collectDangerousKeys({ value, path, errors, seen }) {
    if (!isObjectLike(value) || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
        const items = /** @type {unknown[]} */ (value);
        for (let index = 0; index < items.length; index += 1) {
            collectDangerousKeys({ value: items[index], path: `${path}[${index}]`, errors, seen });
        }
        return;
    }
    const record = /** @type {Record<string, unknown>} */ (value);
    for (const key of Object.keys(record)) {
        const childPath = joinPath({ base: path, key });
        if (FORBIDDEN_KEYS.has(key)) {
            addError({ errors, reason: `invalid_config:${childPath}` });
            continue;
        }
        collectDangerousKeys({ value: record[key], path: childPath, errors, seen });
    }
}

/**
 * Reads one known file section, warning on its unknown children.
 * @param {{source: Record<string, unknown>, key: string, label: string, allowed: readonly string[], errors: string[], warnings: string[]}} arg0
 * @returns {{present: boolean, valid: boolean, value: Record<string, unknown>}}
 */
function readSection({ source, key, label, allowed, errors, warnings }) {
    if (!Object.hasOwn(source, key)) return { present: false, valid: false, value: {} };
    const raw = source[key];
    if (!isPlainObject(raw)) {
        addError({ errors, reason: `invalid_config:${label}` });
        return { present: true, valid: false, value: {} };
    }
    const value = /** @type {Record<string, unknown>} */ (raw);
    for (const child of Object.keys(value)) {
        if (!allowed.includes(child)) warnings.push(`unknown_key:${label}.${child}`);
    }
    return { present: true, valid: true, value };
}

/**
 * @param {{source: Record<string, unknown>, key: string, field: string, min: number, fallback: number, errors: string[], exclusiveMin?: boolean}} arg0
 * @returns {number}
 */
function pickInteger({ source, key, field, min, fallback, errors, exclusiveMin = false }) {
    if (!Object.hasOwn(source, key)) return fallback;
    const value = source[key];
    const inBound = typeof value === 'number' && Number.isInteger(value)
        && (exclusiveMin ? value > min : value >= min);
    if (!inBound) {
        addError({ errors, reason: `invalid_config:${field}` });
        return fallback;
    }
    return /** @type {number} */ (value);
}

/**
 * @param {{source: Record<string, unknown>, key: string, field: string, errors: string[]}} arg0
 * @returns {number|null}
 */
function pickNullableInteger({ source, key, field, errors }) {
    if (!Object.hasOwn(source, key)) return null;
    const value = source[key];
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        addError({ errors, reason: `invalid_config:${field}` });
        return null;
    }
    return value;
}

/**
 * @param {{source: Record<string, unknown>, key: string, field: string, errors: string[]}} arg0
 * @returns {number|null}
 */
function pickNullableNumber({ source, key, field, errors }) {
    if (!Object.hasOwn(source, key)) return null;
    const value = source[key];
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        addError({ errors, reason: `invalid_config:${field}` });
        return null;
    }
    return value;
}

/**
 * Normalizes a string list: trim, drop blanks, dedupe, optionally lowercase.
 * States keep their original spelling; the dedupe key is case-insensitive.
 * @param {{value: unknown, field: string, errors: string[], lowercase?: boolean, caseInsensitiveDedupe?: boolean}} arg0
 * @returns {string[]}
 */
function readStringList({ value, field, errors, lowercase = false, caseInsensitiveDedupe = false }) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        addError({ errors, reason: `invalid_config:${field}` });
        return [];
    }
    /** @type {string[]} */
    const out = [];
    const seen = new Set();
    let sawInvalid = false;
    for (const item of /** @type {unknown[]} */ (value)) {
        if (typeof item !== 'string') {
            sawInvalid = true;
            continue;
        }
        const text = item.trim();
        if (text === '') continue;
        const normalized = lowercase ? text.toLowerCase() : text;
        const dedupeKey = caseInsensitiveDedupe ? normalized.toLowerCase() : normalized;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        out.push(normalized);
    }
    if (sawInvalid) addError({ errors, reason: `invalid_config:${field}` });
    return out;
}

/**
 * Reads one env entry without ever walking the prototype chain. A forbidden
 * name (`__proto__`, `constructor`, `prototype`) is refused even when it is an
 * own key: `$__proto__` would otherwise resolve to `Object.prototype` and the
 * deep freeze would then freeze it globally.
 * @param {{env: Record<string, string|undefined>, name: string}} arg0
 * @returns {string|null} The value, or null when it is absent, empty, or not a string.
 */
function readEnvValue({ env, name }) {
    if (FORBIDDEN_KEYS.has(name) || !Object.hasOwn(env, name)) return null;
    const value = env[name];
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Expands embedded `$NAME` / `${NAME}` references in a path. A reference with a
 * missing or empty value is an error; a `$` without an identifier stays literal.
 * @param {{text: string, field: string, env: Record<string, string|undefined>, errors: string[]}} arg0
 * @returns {string}
 */
function expandEmbedded({ text, field, env, errors }) {
    return text.replace(EMBEDDED_ENV_REF, (_match, braced, bare) => {
        const name = braced ?? bare ?? '';
        const value = readEnvValue({ env, name });
        if (value === null) {
            addError({ errors, reason: `missing_env:${field}:${name}` });
            return '';
        }
        return value;
    });
}

/**
 * Expands `~`/`~/…` and embedded env references, then resolves the result
 * against `baseDir`. Only a bare `~` or a `~/` prefix means the home
 * directory; any other leading `~` (e.g. `~user/ws`) is a config error rather
 * than a relative directory literally named `~user`. The raw string is never
 * returned: every path is absolute.
 * @param {{value: unknown, field: string, baseDir: string, env: Record<string, string|undefined>, home: string, errors: string[], fallback: string}} arg0
 * @returns {string}
 */
function readWorkspacePath({ value, field, baseDir, env, home, errors, fallback }) {
    if (typeof value !== 'string' || value.trim() === '') {
        addError({ errors, reason: `invalid_config:${field}` });
        return fallback;
    }
    let text = expandEmbedded({ text: value, field, env, errors });
    if (text === '~') text = home;
    else if (text.startsWith('~/')) text = join(home, text.slice(2));
    else if (text.startsWith('~')) {
        addError({ errors, reason: `invalid_config:${field}` });
        return fallback;
    }
    return resolve(baseDir, text);
}

/**
 * @param {{source: Record<string, unknown>, key: string, errors: string[]}} arg0
 * @returns {string|null}
 */
function readHook({ source, key, errors }) {
    if (!Object.hasOwn(source, key)) return null;
    const value = source[key];
    if (value === null) return null;
    // Verbatim: no trim, no env expansion. The shell expands the script.
    if (typeof value === 'string' && value.trim() !== '') return value;
    addError({ errors, reason: `invalid_config:hooks.${key}` });
    return null;
}

/**
 * Rebuilds `tracker.provider` as JSON-safe data, expanding a string leaf only
 * when the whole value is `$NAME` or `${NAME}`. Cycles, non-plain objects,
 * non-finite numbers, and depth > 8 are invalid.
 * @param {{value: unknown, path: string, env: Record<string, string|undefined>, errors: string[], depth: number, ancestors: Set<unknown>}} arg0
 * @returns {unknown}
 */
function expandProvider({ value, path, env, errors, depth, ancestors }) {
    if (depth > LIMITS.workflow_provider_max_depth) {
        addError({ errors, reason: `invalid_config:${path}` });
        return null;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const match = EXACT_ENV_REF.exec(value);
        if (!match) return value;
        const name = match[1] ?? match[2] ?? '';
        const resolved = readEnvValue({ env, name });
        if (resolved === null) {
            addError({ errors, reason: `missing_env:${path}:${name}` });
            return '';
        }
        return resolved;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            addError({ errors, reason: `invalid_config:${path}` });
            return null;
        }
        return value;
    }
    if (!isObjectLike(value)) {
        // bigint, function, symbol, undefined: not JSON-safe.
        addError({ errors, reason: `invalid_config:${path}` });
        return null;
    }
    if (ancestors.has(value)) {
        addError({ errors, reason: `invalid_config:${path}` });
        return null;
    }
    const next = new Set(ancestors);
    next.add(value);
    if (Array.isArray(value)) {
        const items = /** @type {unknown[]} */ (value);
        return items.map((item, index) => expandProvider({
            value: item,
            path: `${path}[${index}]`,
            env,
            errors,
            depth: depth + 1,
            ancestors: next
        }));
    }
    if (!isPlainObject(value)) {
        addError({ errors, reason: `invalid_config:${path}` });
        return null;
    }
    const record = /** @type {Record<string, unknown>} */ (value);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(record)) {
        const childPath = joinPath({ base: path, key });
        if (FORBIDDEN_KEYS.has(key)) {
            addError({ errors, reason: `invalid_config:${childPath}` });
            continue;
        }
        out[key] = expandProvider({ value: record[key], path: childPath, env, errors, depth: depth + 1, ancestors: next });
    }
    return out;
}

/**
 * @template T
 * @param {{value: T}} arg0
 * @returns {T}
 */
function deepFreeze({ value }) {
    if (value === null || typeof value !== 'object') return value;
    for (const key of Object.keys(value)) {
        deepFreeze({ value: /** @type {Record<string, unknown>} */ (value)[key] });
    }
    return /** @type {T} */ (Object.freeze(value));
}

/**
 * Resolves the inert front matter into the one validated, frozen config.
 * @param {{config?: unknown, baseDir?: string, env?: Record<string, string|undefined>, home?: string}} [arg0]
 * @returns {{config: ResolvedWorkflowConfig, warnings: string[]}}
 */
export function resolveWorkflowConfig({ config = {}, baseDir = process.cwd(), env = process.env, home = homedir() } = {}) {
    /** @type {string[]} */
    const errors = [];
    /** @type {string[]} */
    const warnings = [];

    if (!isPlainObject(config)) {
        throw new PolicyError({
            message: 'Workflow policy is invalid: 1 error(s)',
            options: { reason: 'invalid_config:config', reasons: ['invalid_config:config'] }
        });
    }
    const source = /** @type {Record<string, unknown>} */ (config);
    collectDangerousKeys({ value: source, path: '', errors, seen: new Set() });

    // tracker is optional; kind is required only when the section is present.
    const trackerSection = readSection({
        source, key: 'tracker', label: 'tracker', allowed: TRACKER_KEYS, errors, warnings
    });
    const trackerRaw = trackerSection.value;
    let trackerKind = null;
    if (trackerSection.present && trackerSection.valid) {
        const rawKind = trackerRaw.kind;
        if (typeof rawKind === 'string' && rawKind.trim() !== '') trackerKind = rawKind.trim();
        else addError({ errors, reason: 'invalid_config:tracker.kind' });
    }
    /** @type {Record<string, unknown>} */
    let provider = {};
    if (Object.hasOwn(trackerRaw, 'provider')) {
        if (!isPlainObject(trackerRaw.provider)) {
            addError({ errors, reason: 'invalid_config:tracker.provider' });
        } else {
            provider = /** @type {Record<string, unknown>} */ (expandProvider({
                value: trackerRaw.provider, path: 'tracker.provider', env, errors, depth: 0, ancestors: new Set()
            }));
        }
    }
    const requiredLabels = readStringList({
        value: trackerRaw.required_labels, field: 'tracker.required_labels', errors, lowercase: true
    });
    const activeStates = readStringList({
        value: trackerRaw.active_states, field: 'tracker.active_states', errors, caseInsensitiveDedupe: true
    });
    const terminalStates = readStringList({
        value: trackerRaw.terminal_states, field: 'tracker.terminal_states', errors, caseInsensitiveDedupe: true
    });
    const activeLower = new Set(activeStates.map((state) => state.toLowerCase()));
    if (terminalStates.some((state) => activeLower.has(state.toLowerCase()))) {
        addError({ errors, reason: 'invalid_config:tracker.terminal_states' });
    }
    if (activeStates.length === 0 && terminalStates.length === 0) {
        warnings.push('no_active_states');
    }

    const pollingRaw = readSection({
        source, key: 'polling', label: 'polling', allowed: POLLING_KEYS, errors, warnings
    }).value;
    const intervalMs = pickInteger({
        source: pollingRaw, key: 'interval_ms', field: 'polling.interval_ms', min: 1, fallback: LIMITS.workflow_poll_interval_ms, errors
    });

    // `workspace.root` is a core key; the strategy/repo/branch extension lives
    // under `merci.workspace` so the Symphony schema keeps its meaning.
    const workspaceRaw = readSection({
        source, key: 'workspace', label: 'workspace', allowed: WORKSPACE_KEYS, errors, warnings
    }).value;
    let merci = {};
    if (Object.hasOwn(source, 'merci')) {
        if (isPlainObject(source.merci)) merci = /** @type {Record<string, unknown>} */ (source.merci);
        else addError({ errors, reason: 'invalid_config:merci' });
    }
    const workspaceExt = readSection({
        source: merci, key: 'workspace', label: 'merci.workspace', allowed: MERCI_WORKSPACE_KEYS, errors, warnings
    }).value;

    const defaultRoot = join(tmpdir(), 'merci-workspaces');
    const workspaceRoot = Object.hasOwn(workspaceRaw, 'root')
        ? readWorkspacePath({ value: workspaceRaw.root, field: 'workspace.root', baseDir, env, home, errors, fallback: defaultRoot })
        : defaultRoot;

    let strategy = /** @type {'directory'|'git-worktree'} */ ('directory');
    if (Object.hasOwn(workspaceExt, 'strategy')) {
        const rawStrategy = workspaceExt.strategy;
        if (rawStrategy === 'directory' || rawStrategy === 'git-worktree') strategy = rawStrategy;
        else addError({ errors, reason: 'invalid_config:workspace.strategy' });
    }

    let repoRoot = null;
    if (Object.hasOwn(workspaceExt, 'repo_root') && workspaceExt.repo_root !== null) {
        repoRoot = readWorkspacePath({
            value: workspaceExt.repo_root, field: 'workspace.repo_root', baseDir, env, home, errors, fallback: ''
        });
        if (repoRoot === '') repoRoot = null;
    }
    if (strategy === 'git-worktree' && repoRoot === null) {
        addError({ errors, reason: 'invalid_config:workspace.repo_root' });
    }

    let baseRef = 'HEAD';
    if (Object.hasOwn(workspaceExt, 'base_ref')) {
        const rawBaseRef = workspaceExt.base_ref;
        if (typeof rawBaseRef === 'string' && rawBaseRef.trim() !== '') baseRef = rawBaseRef.trim();
        else addError({ errors, reason: 'invalid_config:workspace.base_ref' });
    }
    let branchPrefix = 'merci/';
    if (Object.hasOwn(workspaceExt, 'branch_prefix')) {
        const rawPrefix = workspaceExt.branch_prefix;
        if (typeof rawPrefix === 'string') branchPrefix = rawPrefix;
        else addError({ errors, reason: 'invalid_config:workspace.branch_prefix' });
    }

    const hooksRaw = readSection({
        source, key: 'hooks', label: 'hooks', allowed: HOOKS_KEYS, errors, warnings
    }).value;
    const hooks = {
        afterCreate: readHook({ source: hooksRaw, key: 'after_create', errors }),
        beforeRun: readHook({ source: hooksRaw, key: 'before_run', errors }),
        afterRun: readHook({ source: hooksRaw, key: 'after_run', errors }),
        beforeRemove: readHook({ source: hooksRaw, key: 'before_remove', errors }),
        timeoutMs: pickInteger({
            source: hooksRaw, key: 'timeout_ms', field: 'hooks.timeout_ms', min: 1, fallback: LIMITS.workflow_hook_timeout_ms, errors
        })
    };

    const agentRaw = readSection({
        source, key: 'agent', label: 'agent', allowed: AGENT_KEYS, errors, warnings
    }).value;
    /** @type {Record<string, number>} */
    const byState = {};
    if (Object.hasOwn(agentRaw, 'max_concurrent_agents_by_state')) {
        const rawByState = agentRaw.max_concurrent_agents_by_state;
        if (!isPlainObject(rawByState)) {
            addError({ errors, reason: 'invalid_config:agent.max_concurrent_agents_by_state' });
        } else {
            const record = /** @type {Record<string, unknown>} */ (rawByState);
            for (const original of Object.keys(record)) {
                if (FORBIDDEN_KEYS.has(original)) continue; // already a hard error
                const state = original.trim().toLowerCase();
                if (FORBIDDEN_KEYS.has(state)) {
                    // Rule 12 applies after normalization too: `__PROTO__` would
                    // otherwise be a silent own `__proto__` assignment.
                    addError({ errors, reason: `invalid_config:agent.max_concurrent_agents_by_state.${state}` });
                    continue;
                }
                const value = record[original];
                if (state === '' || typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
                    warnings.push(`invalid_by_state:${state}`);
                    continue;
                }
                byState[state] = value;
            }
        }
    }
    const agent = {
        maxConcurrentAgents: pickInteger({
            source: agentRaw, key: 'max_concurrent_agents', field: 'agent.max_concurrent_agents', min: 1, fallback: LIMITS.workflow_max_concurrent_agents, errors
        }),
        maxTurns: pickInteger({
            source: agentRaw, key: 'max_turns', field: 'agent.max_turns', min: 1, fallback: LIMITS.workflow_agent_max_turns, errors
        }),
        maxRetryBackoffMs: pickInteger({
            source: agentRaw, key: 'max_retry_backoff_ms', field: 'agent.max_retry_backoff_ms', min: 0, fallback: LIMITS.workflow_retry_max_backoff_ms, errors
        }),
        maxConcurrentAgentsByState: byState
    };

    const schedulerRaw = readSection({
        source: merci, key: 'scheduler', label: 'merci.scheduler', allowed: MERCI_SCHEDULER_KEYS, errors, warnings
    }).value;
    const scheduler = {
        maxAttemptsPerItem: pickInteger({
            source: schedulerRaw, key: 'max_attempts_per_item', field: 'scheduler.max_attempts_per_item', min: 1, fallback: LIMITS.workflow_max_attempts_per_item, errors
        }),
        continuationMax: pickInteger({
            source: schedulerRaw, key: 'continuation_max', field: 'scheduler.continuation_max', min: 0, fallback: LIMITS.workflow_continuation_max, errors
        }),
        continuationDelayMs: pickInteger({
            source: schedulerRaw, key: 'continuation_delay_ms', field: 'scheduler.continuation_delay_ms', min: 0, fallback: LIMITS.workflow_continuation_delay_ms, errors
        }),
        stallTimeoutMs: pickInteger({
            source: schedulerRaw, key: 'stall_timeout_ms', field: 'scheduler.stall_timeout_ms', min: 0, fallback: LIMITS.workflow_stall_timeout_ms, errors
        }),
        retryBaseMs: pickInteger({
            source: schedulerRaw, key: 'retry_base_ms', field: 'scheduler.retry_base_ms', min: 0, fallback: LIMITS.workflow_retry_base_ms, errors
        }),
        maxTotalTokens: pickNullableInteger({
            source: schedulerRaw, key: 'max_total_tokens', field: 'scheduler.max_total_tokens', errors
        }),
        maxTotalUsd: pickNullableNumber({
            source: schedulerRaw, key: 'max_total_usd', field: 'scheduler.max_total_usd', errors
        }),
        // A host-set dispatch cap survives an applyConfig reload only when it is
        // part of the mapped config, so it is resolved explicitly here.
        maxDispatches: pickNullableInteger({
            source: schedulerRaw, key: 'max_dispatches', field: 'scheduler.max_dispatches', errors
        })
    };
    // The scheduler refuses this pair at start()/applyConfig(); refusing it here
    // keeps the last-known-good policy instead of a healthy one that cannot apply.
    if (scheduler.retryBaseMs > agent.maxRetryBackoffMs) {
        addError({ errors, reason: 'invalid_config:scheduler.retry_base_ms' });
    }

    const engineRaw = readSection({
        source: merci, key: 'engine', label: 'merci.engine', allowed: MERCI_ENGINE_KEYS, errors, warnings
    }).value;
    let engineKind = /** @type {'agentic'|'dag'|'stateMachine'|'discussion'} */ ('agentic');
    if (Object.hasOwn(engineRaw, 'kind')) {
        const rawKind = engineRaw.kind;
        if (rawKind === 'agentic' || rawKind === 'dag' || rawKind === 'stateMachine' || rawKind === 'discussion') {
            engineKind = rawKind;
        } else {
            addError({ errors, reason: 'invalid_config:engine.kind' });
        }
    }
    let engineModel = null;
    if (Object.hasOwn(engineRaw, 'model') && engineRaw.model !== null) {
        const rawModel = engineRaw.model;
        if (typeof rawModel === 'string' && rawModel.trim() !== '') engineModel = rawModel.trim();
        else addError({ errors, reason: 'invalid_config:engine.model' });
    }

    for (const key of Object.keys(source)) {
        if (TOP_LEVEL_KEYS.includes(key) || FORBIDDEN_KEYS.has(key)) continue;
        // `codex` is the one unknown section a Symphony user will expect to work.
        if (key === 'codex') warnings.push('unsupported_section:codex');
    }

    if (errors.length > 0) {
        throw new PolicyError({
            message: `Workflow policy is invalid: ${errors.length} error(s)`,
            options: { reason: errors[0], reasons: errors }
        });
    }

    /** @type {ResolvedWorkflowConfig} */
    const resolved = {
        tracker: {
            kind: trackerKind,
            provider,
            requiredLabels,
            activeStates,
            terminalStates
        },
        polling: { intervalMs },
        workspace: {
            root: workspaceRoot,
            strategy,
            repoRoot,
            baseRef,
            branchPrefix
        },
        hooks,
        agent,
        scheduler,
        engine: { kind: engineKind, model: engineModel }
    };
    return {
        config: deepFreeze({ value: resolved }),
        warnings: deepFreeze({ value: warnings })
    };
}

/**
 * The operator-safe projection: provider keys and hook presence only. This is
 * not a deep clone of the config; every field is copied explicitly so a new
 * secret-bearing field cannot leak by inheritance.
 * @param {{config: ResolvedWorkflowConfig}} arg0
 * @returns {Record<string, unknown>}
 */
export function redactConfig({ config }) {
    /** @type {Record<string, number>} */
    const byState = {};
    for (const key of Object.keys(config.agent.maxConcurrentAgentsByState)) {
        byState[key] = config.agent.maxConcurrentAgentsByState[key];
    }
    return {
        tracker: {
            kind: config.tracker.kind,
            provider: { redacted: true, keys: Object.keys(config.tracker.provider).sort() },
            requiredLabels: [...config.tracker.requiredLabels],
            activeStates: [...config.tracker.activeStates],
            terminalStates: [...config.tracker.terminalStates]
        },
        polling: { intervalMs: config.polling.intervalMs },
        workspace: {
            root: config.workspace.root,
            strategy: config.workspace.strategy,
            repoRoot: config.workspace.repoRoot,
            baseRef: config.workspace.baseRef,
            branchPrefix: config.workspace.branchPrefix
        },
        hooks: {
            afterCreate: config.hooks.afterCreate !== null,
            beforeRun: config.hooks.beforeRun !== null,
            afterRun: config.hooks.afterRun !== null,
            beforeRemove: config.hooks.beforeRemove !== null,
            timeoutMs: config.hooks.timeoutMs
        },
        agent: {
            maxConcurrentAgents: config.agent.maxConcurrentAgents,
            maxTurns: config.agent.maxTurns,
            maxRetryBackoffMs: config.agent.maxRetryBackoffMs,
            maxConcurrentAgentsByState: byState
        },
        scheduler: {
            maxAttemptsPerItem: config.scheduler.maxAttemptsPerItem,
            continuationMax: config.scheduler.continuationMax,
            continuationDelayMs: config.scheduler.continuationDelayMs,
            stallTimeoutMs: config.scheduler.stallTimeoutMs,
            retryBaseMs: config.scheduler.retryBaseMs,
            maxTotalTokens: config.scheduler.maxTotalTokens,
            maxTotalUsd: config.scheduler.maxTotalUsd,
            maxDispatches: config.scheduler.maxDispatches
        },
        engine: { kind: config.engine.kind, model: config.engine.model }
    };
}
