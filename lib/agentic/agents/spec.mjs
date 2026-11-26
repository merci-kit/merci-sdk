// @ts-check


/**
 * @file Normalize one parsed `*.agent.yaml` mapping into a deep-frozen
 * `AgentSpec`.
 * @version 0.12.0
 *
 * @description
 * The trust boundary for the file format. Every level is strict — an unknown key
 * is a hard error carrying the dotted field and its source line, never a
 * warning — and validation collects every failure instead of stopping at the
 * first. Nothing here merges parsed YAML into another object: each field is
 * copied into a new one, so a `__proto__`, `constructor` or `prototype` key can
 * never reach a prototype.
 *
 * `normalizeAgentSpec` is async because a script definition is proven by
 * `resolveScript` (a real `lstat`/`realpath`/read), which is the same check the
 * runner uses. A file that points at a symlink, an outside path, an unknown
 * extension or an oversized script therefore fails at load, before anything is
 * spawned.
 *
 * The returned object is inert data. It carries no tool instance, no callback
 * and no session; adapters build those later.
 */
import { basename } from 'node:path';

import { AgentFileError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { deepFreeze } from '../../support/object.mjs';
import { resolveScript } from '../../tools/script-tools.mjs';
import { AGENT_TOOL_GROUPS, expandAgentGroup } from './catalog.mjs';


/** The one format version v1 reads. */
export const AGENT_API_VERSION = 'merci.dev/v1alpha1';

/** The one document kind v1 reads. */
export const AGENT_KIND = 'Agent';


/**
 * Every stable reason an `AgentFileError` from this format may carry. Pinned:
 * a consumer branches on these strings, never on the message.
 * @type {ReadonlyArray<string>}
 */
export const AGENT_FILE_REASONS = Object.freeze([
    'agent_read_error',
    'agent_too_large',
    'agent_parse_error',
    'agent_not_a_map',
    'agent_unknown_key',
    'agent_invalid_field',
    'agent_unsupported_api_version',
    'agent_unsupported_kind',
    'agent_name_mismatch',
    'agent_duplicate_name',
    'agent_missing_group',
    'agent_profile_unsupported',
    'agent_unknown_model',
    'agent_dangerous_mode',
    'agent_symlink',
    'agent_script_outside_root',
    'agent_script_too_large',
    'agent_script_unsupported',
    'agent_duplicate_tool'
]);


/** @typedef {object} AgentScriptDefinition
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} parameters
 * @property {string} script - The path exactly as the file wrote it.
 * @property {string} scriptPath - The resolved real absolute path.
 * @property {string} interpreter
 * @property {string} scriptHash - sha256 of the script bytes.
 * @property {number} size
 * @property {number} timeoutMs
 * @property {boolean} requiresApproval
 * @property {string[]} env - Parent environment keys to forward, never values.
 * @property {string} baseDir
 */

/** @typedef {object} AgentSpec
 * @property {string} apiVersion
 * @property {string} kind
 * @property {string} name
 * @property {string} description
 * @property {{kind: 'role'|'id', value: string}} model
 * @property {string} instructions
 * @property {{
 *   use: string[],
 *   allow: string[],
 *   deny: string[],
 *   mode: 'default'|'acceptEdits'|'bypassPermissions',
 *   definitions: AgentScriptDefinition[]
 * }} tools
 * @property {{maxIterations?: number, maxDepth?: number, timeoutMs?: number, maxElapsedMs?: number}} limits
 * @property {{path: string|null, hash: string}} source
 */

/** @typedef {{line: number, column: number}} YamlPosition */

/** @typedef {{reason: string, field: string|null, line: number|null, column: number|null}} AgentIssue */

/** A key that would touch a prototype if it were ever merged in. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** JSON-Schema keys that are never valid in a tool `parameters` mapping. */
const PARAMETER_BAD_KEYS = new Set([...DANGEROUS_KEYS, '<<']);

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SELECTOR_PATTERN = /^(?:native|host|skill|script|mcp|acp|a2a):\S+$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ROOT_KEYS = Object.freeze(['apiVersion', 'kind', 'metadata', 'spec']);
const METADATA_KEYS = Object.freeze(['name', 'description']);
const SPEC_KEYS = Object.freeze(['model', 'instructions', 'tools', 'limits']);
const TOOL_KEYS = Object.freeze(['use', 'allow', 'deny', 'mode', 'definitions']);
const DEFINITION_KEYS = Object.freeze(['name', 'description', 'parameters', 'script', 'timeoutMs', 'requiresApproval', 'env']);
const LIMIT_KEYS = Object.freeze(['maxIterations', 'maxDepth', 'timeoutMs', 'maxElapsedMs']);
const TOOL_MODES = Object.freeze(['default', 'acceptEdits', 'bypassPermissions']);
const MODEL_ROLES = Object.freeze(['default', 'tool', 'decision']);

/** Every tool name a group can yield; a script tool may not shadow one. */
const CATALOG_TOOL_NAMES = new Set(Object.values(AGENT_TOOL_GROUPS).flatMap((group) => [...group.tools]));

/** Tool names the SDK itself registers at run time; a file may not take them. */
const RESERVED_TOOL_NAMES = new Set([...CATALOG_TOOL_NAMES, 'tool_search', 'plan_exit', 'load_artifacts']);


/**
 * @param {unknown} value -
 * @returns {boolean}
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}


/**
 * @param {unknown} value -
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return isPlainObject(value);
}


/**
 * @param {{issues: AgentIssue[], positions: Map<string, YamlPosition>, reason: string, field: string|null}} arg0
 * @returns {void}
 */
function addIssue({ issues, positions, reason, field }) {
    const position = field === null ? undefined : positions.get(field);
    issues.push({ reason, field, line: position?.line ?? null, column: position?.column ?? null });
}


/**
 * Reports every key not in `allowed`. A prototype-touching key is reported the
 * same way: it can never be a legitimate field.
 * @param {{value: Record<string, unknown>, field: string, allowed: readonly string[], issues: AgentIssue[], positions: Map<string, YamlPosition>}} arg0
 * @returns {void}
 */
function rejectUnknownKeys({ value, field, allowed, issues, positions }) {
    for (const key of Object.keys(value)) {
        if (DANGEROUS_KEYS.has(key) || !allowed.includes(key)) {
            const path = field ? `${field}.${key}` : key;
            addIssue({ issues, positions, reason: 'agent_unknown_key', field: path });
        }
    }
}


/**
 * @param {{issues: AgentIssue[], path: string|null}} arg0
 * @returns {never}
 */
function throwIssues({ issues, path }) {
    const first = /** @type {AgentIssue} */ (issues[0]);
    const count = issues.length;
    const hint = issues.some((issue) => issue.field !== null && issue.field.startsWith('spec.tools.use'))
        ? ` Valid groups: ${Object.keys(AGENT_TOOL_GROUPS).join(', ')}, all.`
        : issues.some((issue) => issue.field === 'spec.model')
            ? ' Model must be default, tool, decision, or a bare model id.'
            : '';
    throw new AgentFileError({
        message: `Agent definition is invalid (${count} error${count === 1 ? '' : 's'}).${hint}`,
        options: {
            reason: first.reason,
            reasons: issues.map((issue) => issue.reason),
            field: first.field,
            path,
            line: first.line,
            column: first.column,
            issues: issues.map((issue) => ({
                reason: issue.reason,
                field: issue.field,
                line: issue.line,
                column: issue.column
            }))
        }
    });
}


/**
 * @param {{raw: Record<string, unknown>, issues: AgentIssue[], positions: Map<string, YamlPosition>}} arg0
 * @returns {{kind: 'role'|'id', value: string}}
 */
function normalizeModel({ raw, issues, positions }) {
    if (raw.model === undefined || raw.model === null) return { kind: 'role', value: 'default' };
    if (typeof raw.model !== 'string' || raw.model.trim() === '') {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'spec.model' });
        return { kind: 'role', value: 'default' };
    }
    const value = raw.model.trim();
    if (MODEL_ROLES.includes(value)) return { kind: 'role', value };
    if (value.includes('/')) {
        addIssue({ issues, positions, reason: 'agent_unknown_model', field: 'spec.model' });
        return { kind: 'role', value: 'default' };
    }
    return { kind: 'id', value };
}


/**
 * @param {{rawValue: unknown, field: string, issues: AgentIssue[], positions: Map<string, YamlPosition>}} arg0
 * @returns {string[]}
 */
function normalizeSelectorList({ rawValue, field, issues, positions }) {
    if (rawValue === undefined || rawValue === null) return [];
    if (!Array.isArray(rawValue)) {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field });
        return [];
    }
    if (rawValue.length > LIMITS.agent_max_selectors) {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field });
    }
    /** @type {string[]} */
    const selectors = [];
    for (const [index, entry] of rawValue.entries()) {
        const entryField = `${field}.${index}`;
        if (typeof entry !== 'string' || entry.trim() === '') {
            addIssue({ issues, positions, reason: 'agent_invalid_field', field: entryField });
            continue;
        }
        const selector = entry.trim();
        if (selector === '*') selectors.push(selector);
        else if (!SELECTOR_PATTERN.test(selector)) {
            addIssue({ issues, positions, reason: 'agent_invalid_field', field: entryField });
        } else selectors.push(selector);
    }
    return selectors;
}


/**
 * The first `__proto__` / `constructor` / `prototype` key anywhere in a value,
 * as a dotted path, or null. Bounded by `cap_max_depth` so a pathological
 * nesting cannot overflow the stack.
 * @param {{value: unknown, prefix?: string, depth?: number, keys?: Set<string>}} arg0
 * @returns {string|null}
 */
function dangerousKeyPath({ value, prefix = '', depth = 0, keys = DANGEROUS_KEYS }) {
    if (depth > LIMITS.cap_max_depth) return null;
    if (value === null || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            const found = dangerousKeyPath({ value: value[index], prefix: `${prefix}.${index}`, depth: depth + 1, keys });
            if (found) return found;
        }
        return null;
    }
    for (const key of Object.keys(value)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (keys.has(key)) return path;
        const found = dangerousKeyPath({ value: /** @type {Record<string, unknown>} */ (value)[key], prefix: path, depth: depth + 1, keys });
        if (found) return found;
    }
    return null;
}


/**
 * Resolves one script definition. A `resolveScript` failure is translated to the
 * agent reason and the field keeps the definition index, so the message can
 * name the entry without quoting the file.
 * @param {{raw: Record<string, unknown>, index: number, issues: AgentIssue[], positions: Map<string, YamlPosition>, baseDir: string|undefined, root: string|undefined, allowDangerous: boolean}} arg0
 * @returns {Promise<AgentScriptDefinition|null>}
 */
async function normalizeDefinition({ raw, index, issues, positions, baseDir, root, allowDangerous }) {
    const field = `spec.tools.definitions.${index}`;
    rejectUnknownKeys({ value: raw, field, allowed: DEFINITION_KEYS, issues, positions });

    let name = '';
    if (typeof raw.name !== 'string' || !TOOL_NAME_PATTERN.test(raw.name)) {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: `${field}.name` });
    } else name = raw.name;

    let description = '';
    if (typeof raw.description !== 'string' || raw.description.trim() === '') {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: `${field}.description` });
    } else description = raw.description;

    /** @type {Record<string, unknown>} */
    let parameters = {};
    if (!isRecord(raw.parameters) || raw.parameters.type !== 'object') {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: `${field}.parameters` });
    } else {
        parameters = raw.parameters;
        const dangerous = dangerousKeyPath({ value: parameters, keys: PARAMETER_BAD_KEYS });
        if (dangerous) {
            addIssue({ issues, positions, reason: 'agent_unknown_key', field: `${field}.parameters.${dangerous}` });
        }
    }

    let timeoutMs = LIMITS.agent_script_timeout_ms;
    if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) {
        if (typeof raw.timeoutMs !== 'number' || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs <= 0) {
            addIssue({ issues, positions, reason: 'agent_invalid_field', field: `${field}.timeoutMs` });
        } else {
            timeoutMs = Math.min(raw.timeoutMs, LIMITS.agent_script_timeout_ms);
        }
    }

    let requiresApproval = true;
    if (raw.requiresApproval !== undefined && raw.requiresApproval !== null) {
        if (typeof raw.requiresApproval !== 'boolean') {
            addIssue({ issues, positions, reason: 'agent_invalid_field', field: `${field}.requiresApproval` });
        } else requiresApproval = raw.requiresApproval;
    }
    if (requiresApproval === false && !allowDangerous) {
        addIssue({ issues, positions, reason: 'agent_dangerous_mode', field: `${field}.requiresApproval` });
    }

    /** @type {string[]} */
    const env = [];
    if (raw.env !== undefined && raw.env !== null) {
        if (!Array.isArray(raw.env)) {
            addIssue({ issues, positions, reason: 'agent_invalid_field', field: `${field}.env` });
        } else {
            if (raw.env.length > LIMITS.agent_max_env_keys) {
                addIssue({ issues, positions, reason: 'agent_invalid_field', field: `${field}.env` });
            }
            for (const [envIndex, key] of raw.env.entries()) {
                if (typeof key !== 'string' || !ENV_KEY_PATTERN.test(key)) {
                    addIssue({ issues, positions, reason: 'agent_invalid_field', field: `${field}.env.${envIndex}` });
                } else env.push(key);
            }
        }
    }

    if (typeof raw.script !== 'string' || raw.script.trim() === '') {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: `${field}.script` });
        return null;
    }
    if (typeof baseDir !== 'string' || !baseDir || typeof root !== 'string' || !root) {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: `${field}.script` });
        return null;
    }
    try {
        const resolved = await resolveScript({
            script: raw.script,
            baseDir,
            root,
            maxBytes: LIMITS.agent_script_max_bytes
        });
        return {
            name,
            description,
            parameters,
            script: raw.script,
            scriptPath: resolved.path,
            interpreter: resolved.interpreter,
            scriptHash: resolved.hash,
            size: resolved.size,
            timeoutMs,
            requiresApproval,
            env,
            baseDir
        };
    } catch (error) {
        const code = isRecord(error) && typeof error.reason === 'string' ? error.reason : 'script_missing';
        // script_missing and script_not_file are a bad field, not a script
        // policy violation; both map onto agent_invalid_field.
        const mapped = code === 'script_outside_root' ? 'agent_script_outside_root'
            : code === 'script_symlink' ? 'agent_symlink'
                : code === 'script_too_large' ? 'agent_script_too_large'
                    : code === 'script_unsupported' ? 'agent_script_unsupported'
                        : 'agent_invalid_field';
        addIssue({ issues, positions, reason: mapped, field: `${field}.script` });
        return null;
    }
}


/**
 * @param {{raw: Record<string, unknown>, issues: AgentIssue[], positions: Map<string, YamlPosition>}} arg0
 * @returns {AgentSpec['limits']}
 */
function normalizeLimits({ raw, issues, positions }) {
    /** @type {AgentSpec['limits']} */
    const limits = {};
    if (raw.limits === undefined || raw.limits === null) return limits;
    if (!isRecord(raw.limits)) {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'spec.limits' });
        return limits;
    }
    rejectUnknownKeys({ value: raw.limits, field: 'spec.limits', allowed: LIMIT_KEYS, issues, positions });
    for (const key of LIMIT_KEYS) {
        const value = raw.limits[key];
        if (value === undefined || value === null) continue;
        const field = `spec.limits.${key}`;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
            addIssue({ issues, positions, reason: 'agent_invalid_field', field });
            continue;
        }
        // The format's own sanity ceiling, not the runtime's effective default:
        // storing `8` as `5` would silently rewrite the author's intent, and the
        // runtime still applies its configured maximum when it runs the turn.
        const ceiling = key === 'maxIterations' ? LIMITS.agent_max_iterations
            : key === 'maxDepth' ? LIMITS.agent_max_depth
                : key === 'timeoutMs' ? LIMITS.agent_timeout_ms
                    : LIMITS.agent_max_elapsed_ms;
        const clamped = Math.min(value, ceiling);
        if (key === 'maxIterations') limits.maxIterations = clamped;
        else if (key === 'maxDepth') limits.maxDepth = clamped;
        else if (key === 'timeoutMs') limits.timeoutMs = clamped;
        else limits.maxElapsedMs = clamped;
    }
    return limits;
}


/**
 * Validates one parsed agent definition into a deep-frozen spec. Every failure
 * is collected; one `AgentFileError` reports all of them, and `field` is the
 * first offending dotted path.
 * @param {{
 *   value?: Record<string, unknown>,
 *   path?: string|null,
 *   positions?: Map<string, YamlPosition>,
 *   baseDir?: string,
 *   root?: string,
 *   allowDangerous?: boolean,
 *   hash?: string
 * }} [arg0] -
 * @returns {Promise<Readonly<AgentSpec>>}
 */
export async function normalizeAgentSpec({
    value,
    path = null,
    positions = new Map(),
    baseDir,
    root,
    allowDangerous = false,
    hash = ''
} = {}) {
    /** @type {AgentIssue[]} */
    const issues = [];
    if (!isRecord(value)) {
        throw new AgentFileError({
            message: 'Agent definition must be a YAML mapping.',
            options: { reason: 'agent_not_a_map', path }
        });
    }

    rejectUnknownKeys({ value, field: '', allowed: ROOT_KEYS, issues, positions });

    if (value.apiVersion !== AGENT_API_VERSION) {
        addIssue({ issues, positions, reason: 'agent_unsupported_api_version', field: 'apiVersion' });
    }
    if (value.kind !== AGENT_KIND) {
        addIssue({ issues, positions, reason: 'agent_unsupported_kind', field: 'kind' });
    }

    /** @type {Record<string, unknown>} */
    let metadata = {};
    if (!isRecord(value.metadata)) {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'metadata' });
    } else {
        metadata = value.metadata;
        rejectUnknownKeys({ value: metadata, field: 'metadata', allowed: METADATA_KEYS, issues, positions });
    }

    let name = '';
    if (typeof metadata.name !== 'string' || metadata.name === '') {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'metadata.name' });
    } else if (metadata.name.length > LIMITS.agent_name_max || !NAME_PATTERN.test(metadata.name)) {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'metadata.name' });
    } else {
        name = metadata.name;
        const stem = path ? basename(path, '.agent.yaml') : null;
        if (stem !== null && name !== stem) {
            addIssue({ issues, positions, reason: 'agent_name_mismatch', field: 'metadata.name' });
        }
    }

    let description = '';
    if (typeof metadata.description !== 'string' || metadata.description.trim() === '') {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'metadata.description' });
    } else if (metadata.description.length > LIMITS.agent_description_max_chars) {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'metadata.description' });
    } else if (/[\r\n]/.test(metadata.description)) {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'metadata.description' });
    } else description = metadata.description;

    /** @type {Record<string, unknown>} */
    let rawSpec = {};
    if (!isRecord(value.spec)) {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'spec' });
    } else {
        rawSpec = value.spec;
        rejectUnknownKeys({ value: rawSpec, field: 'spec', allowed: SPEC_KEYS, issues, positions });
    }

    let instructions = '';
    if (typeof rawSpec.instructions !== 'string' || rawSpec.instructions.trim() === '') {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'spec.instructions' });
    } else if (rawSpec.instructions.length > LIMITS.agent_instructions_max_chars) {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'spec.instructions' });
    } else instructions = rawSpec.instructions;

    const model = normalizeModel({ raw: rawSpec, issues, positions });

    /** @type {Record<string, unknown>} */
    let rawTools = {};
    if (rawSpec.tools === undefined || rawSpec.tools === null) {
        // Absent tools is legal; the toolbox later reports agent_missing_group.
    } else if (!isRecord(rawSpec.tools)) {
        addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'spec.tools' });
    } else {
        rawTools = rawSpec.tools;
        rejectUnknownKeys({ value: rawTools, field: 'spec.tools', allowed: TOOL_KEYS, issues, positions });
    }

    /** @type {string[]} */
    const use = [];
    if (rawTools.use !== undefined && rawTools.use !== null) {
        if (!Array.isArray(rawTools.use)) {
            addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'spec.tools.use' });
        } else {
            for (const [index, entry] of rawTools.use.entries()) {
                const field = `spec.tools.use.${index}`;
                if (typeof entry !== 'string' || entry.trim() === '') {
                    addIssue({ issues, positions, reason: 'agent_invalid_field', field });
                    continue;
                }
                const groupName = entry.trim();
                if (groupName === 'all') {
                    if (!allowDangerous) addIssue({ issues, positions, reason: 'agent_dangerous_mode', field });
                    use.push('all');
                    continue;
                }
                const expanded = expandAgentGroup({ name: groupName });
                if (!expanded) {
                    addIssue({ issues, positions, reason: 'agent_invalid_field', field });
                    continue;
                }
                for (const group of expanded) if (!use.includes(group)) use.push(group);
            }
        }
    }

    const allow = normalizeSelectorList({ rawValue: rawTools.allow, field: 'spec.tools.allow', issues, positions });
    const deny = normalizeSelectorList({ rawValue: rawTools.deny, field: 'spec.tools.deny', issues, positions });
    if (allow.includes('*') && !allowDangerous) {
        addIssue({ issues, positions, reason: 'agent_dangerous_mode', field: 'spec.tools.allow' });
    }
    for (const selector of [...allow, ...deny]) {
        if (/^(native|host|skill|script|mcp|acp|a2a):\*(\/|$)/.test(selector) && !allowDangerous) {
            addIssue({ issues, positions, reason: 'agent_dangerous_mode', field: 'spec.tools.allow' });
        }
    }

    /** @type {'default'|'acceptEdits'|'bypassPermissions'} */
    let mode = 'default';
    if (rawTools.mode !== undefined && rawTools.mode !== null) {
        if (typeof rawTools.mode !== 'string' || !TOOL_MODES.includes(rawTools.mode)) {
            addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'spec.tools.mode' });
        } else {
            mode = /** @type {'default'|'acceptEdits'|'bypassPermissions'} */ (rawTools.mode);
        }
    }
    if (mode === 'bypassPermissions' && !allowDangerous) {
        addIssue({ issues, positions, reason: 'agent_dangerous_mode', field: 'spec.tools.mode' });
    }

    /** @type {AgentScriptDefinition[]} */
    const definitions = [];
    const seenNames = new Set();
    if (rawTools.definitions !== undefined && rawTools.definitions !== null) {
        if (!Array.isArray(rawTools.definitions)) {
            addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'spec.tools.definitions' });
        } else {
            if (rawTools.definitions.length > LIMITS.agent_max_script_tools) {
                addIssue({ issues, positions, reason: 'agent_invalid_field', field: 'spec.tools.definitions' });
            }
            const entries = rawTools.definitions.slice(0, LIMITS.agent_max_script_tools);
            for (const [index, entry] of entries.entries()) {
                const field = `spec.tools.definitions.${index}`;
                if (!isRecord(entry)) {
                    addIssue({ issues, positions, reason: 'agent_invalid_field', field });
                    continue;
                }
                const definition = await normalizeDefinition({
                    raw: entry, index, issues, positions, baseDir, root, allowDangerous
                });
                const declared = typeof entry.name === 'string' ? entry.name : '';
                if (declared) {
                    if (seenNames.has(declared) || RESERVED_TOOL_NAMES.has(declared)) {
                        addIssue({ issues, positions, reason: 'agent_duplicate_tool', field: `${field}.name` });
                    }
                    seenNames.add(declared);
                }
                if (definition) definitions.push(definition);
            }
        }
    }

    const limits = normalizeLimits({ raw: rawSpec, issues, positions });

    if (issues.length > 0) throwIssues({ issues, path });

    return /** @type {Readonly<AgentSpec>} */ (deepFreeze({ value: {
        apiVersion: AGENT_API_VERSION,
        kind: AGENT_KIND,
        name,
        description,
        model,
        instructions,
        tools: { use, allow, deny, mode, definitions },
        limits,
        source: { path, hash }
    } }));
}
