// @ts-check

/**
 * @file Tool permission rules.
 * @version 0.12.0
 *
 * @description
 * Which tools an agent may call is a **policy**, not a detail of the tool
 * list. This module holds the policy vocabulary every incumbent agent SDK
 * exposes:
 *
 *   - **allow / deny lists** — tool names or glob patterns. `read_*`
 *     matches a family, `read_file` matches exactly one tool. An empty allow
 *     list means "no restriction"; a deny list always wins. Rules match tool
 *     *names* only: an argument pattern such as `Bash(rm:*)` can never match
 *     and is rejected with a `ConfigurationError` instead of silently
 *     matching nothing.
 *   - **permission modes** — how a *gated* tool (one that declares
 *     `requiresApproval`) is treated:
 *       - `default` — every gated tool asks the approval handler (today's
 *         behaviour).
 *       - `acceptEdits` — tools the SDK brands as file edits
 *         (`editsFiles: true`, and not `runsCode`) are approved
 *         automatically; every other gated tool still asks. The name is not
 *         the brand: a remote `delete_repository` still asks.
 *       - `bypassPermissions` — no gated tool asks. This is an explicit,
 *         dangerous opt-in and the SDK warns when it is used.
 *
 * The patterns are matched with a plain glob (`*` matches any run of
 * characters) so a rule reads like the tool it names, with no regex escaping
 * in configuration files.
 */

import { ConfigurationError } from '../core/errors.mjs';

/**
 * @typedef {'default'|'acceptEdits'|'bypassPermissions'} PermissionMode
 */

/**
 * @typedef {Object} PermissionRules
 * @property {string[]} [allow] - Allowed tool names or globs (empty = no restriction).
 * @property {string[]} [deny] - Denied tool names or globs (always wins).
 * @property {PermissionMode} [mode] - How gated tools are treated.
 */

/** The permission modes this SDK understands. */
export const PERMISSION_MODES = Object.freeze(['default', 'acceptEdits', 'bypassPermissions']);

/**
 * Tool names that count as an edit family for the allow / deny rule globs
 * (for example `deny: ['delete*']`). Not the `acceptEdits` gate — see
 * `stillRequiresApproval`.
 * @type {string[]}
 */
const EDIT_TOOL_PATTERNS = [
    'write*', 'edit*', 'patch*', 'apply_patch*', 'create*', 'delete*', 'remove*',
    'move*', 'rename*', 'mkdir*', 'notebook_edit*'
];

/**
 * Matches a name against a glob pattern (`*` matches any run of characters).
 * @param {{ name: string, pattern: string }} arg0 -
 * @returns {boolean}
 */
export function matchesGlob({ name, pattern }) {
    if (typeof name !== 'string' || typeof pattern !== 'string') return false;
    if (pattern === name) return true;
    if (!pattern.includes('*')) return false;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(name);
}

/**
 * Whether a tool name passes the allow / deny lists.
 *
 * The deny list always wins. An empty allow list means "everything that is
 * not denied". A non-empty allow list means "only what matches".
 *
 * @param {{ name: string, allow?: string[], deny?: string[] }} arg0 -
 * @returns {boolean}
 */
export function isToolPermitted({ name, allow = [], deny = [] }) {
    if (typeof name !== 'string' || name.length === 0) return false;
    const denied = (Array.isArray(deny) ? deny : []).some((pattern) => matchesGlob({ name, pattern }));
    if (denied) return false;
    const allowed = (Array.isArray(allow) ? allow : []).filter((p) => typeof p === 'string');
    if (allowed.length === 0) return true;
    return allowed.some((pattern) => matchesGlob({ name, pattern }));
}

/**
 * Whether a tool name looks like an edit (write / patch / delete / move).
 * @param {{ name: string }} arg0 -
 * @returns {boolean}
 */
export function isEditTool({ name }) {
    if (typeof name !== 'string') return false;
    return EDIT_TOOL_PATTERNS.some((pattern) => matchesGlob({ name, pattern }));
}

/**
 * Whether a gated tool still has to ask under the given permission mode.
 *
 * `acceptEdits` auto-approves only a tool the SDK brands `editsFiles: true`,
 * and a tool that runs code is never an edit: a skill named `write_x` would
 * otherwise run its scripts without asking. The name is deliberately not the
 * gate — an MCP tool named `delete_repository` never carries the brand, so it
 * still asks. `name` stays in the signature for callers and the allow/deny
 * globs (`isEditTool`).
 *
 * @param {{ name: string, mode?: PermissionMode, requiresApproval: boolean, tool?: { runsCode?: boolean, editsFiles?: boolean }|null }} arg0 -
 * @returns {boolean} `true` when the tool must still be approved.
 */
export function stillRequiresApproval({ name, mode = 'default', requiresApproval, tool = null }) {
    if (!requiresApproval) return false;
    if (mode === 'bypassPermissions') return false;
    if (mode === 'acceptEdits' && tool?.editsFiles === true && tool?.runsCode !== true) return false;
    return true;
}

/**
 * Normalizes a caller-supplied rule bag into the canonical shape.
 *
 * @param {{ rules?: PermissionRules|null }} arg0 -
 * @returns {PermissionRules}
 * @throws {ConfigurationError} when a pattern contains `(` (an argument pattern such as `Bash(rm:*)`).
 */
export function normalizePermissionRules({ rules }) {
    const allow = Array.isArray(rules?.allow) ? rules.allow.filter((p) => typeof p === 'string') : [];
    const deny = Array.isArray(rules?.deny) ? rules.deny.filter((p) => typeof p === 'string') : [];
    // A tool name never contains `(`, so `Bash(rm:*)` would match nothing — a deny rule that silently denies nothing.
    const argumentPattern = [...allow, ...deny].find((p) => p.includes('('));
    if (argumentPattern) {
        throw new ConfigurationError({
            message: `Permission rule "${argumentPattern}" matches tool arguments; rules match tool names only (e.g. "run_command", "read_*"). Gate arguments with an approval handler or a guardrail.`,
            options: { option: 'withPermissions' }
        });
    }
    const mode = PERMISSION_MODES.includes(/** @type {any} */ (rules?.mode)) ? /** @type {any} */ (rules?.mode) : 'default';
    return { allow, deny, mode };
}
