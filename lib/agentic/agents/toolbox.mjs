// @ts-check


/**
 * @file Agent tool resolution: groups, selectors and sources become concrete
 * tool objects and session actions.
 * @version 0.12.0
 *
 * @description
 * `resolveToolset` is the one place that answers "what did this file grant?".
 * Both consumers (a profile and a session) call it, so they cannot disagree.
 *
 * Three concepts, one namespace:
 *   - a **group** (`spec.tools.use`) is a catalog entry with a stable name;
 *   - a **selector** (`spec.tools.allow` / `deny`) addresses one source
 *     (`native:read`, `host:write_file`, `script:lint`, `mcp:github/issues_*`);
 *   - a **source** is a live object the host registered on the toolbox. A file
 *     can select one; it can never define one.
 *
 * External tools are renamed at the boundary (`mcp__github__issues_list`) so a
 * remote catalog cannot shadow `read` or `execute_shell_command`. The execute
 * closures capture the original protocol name, so only the advertised name
 * changes. Native and host tools keep their names.
 *
 * `deny` always wins; a selector that matches nothing is an error for a static
 * source and, for an unenumerated dynamic one, a warning only when the toolbox
 * opts into that leniency (`strictDynamic: false`).
 */
import { AgentFileError } from '../../core/errors.mjs';
import { LIMITS } from '../../core/limit-config.mjs';
import { createScriptTool } from '../../tools/script-tools.mjs';
import {
    AGENT_META_GROUPS,
    AGENT_SELECTOR_SOURCES,
    AGENT_TOOL_GROUPS,
    agentGroupToolNames,
    expandAgentGroup
} from './catalog.mjs';
import { matchesGlob } from '../permissions.mjs';
import { createWorkspaceTools } from '../workspace/toolbox.mjs';


/**
 * The subset of a loaded spec resolution reads.
 * @typedef {Object} AgentSpecLike
 * @property {string} [name]
 * @property {string} [instructions]
 * @property {{kind: 'role'|'id', value: string}} [model]
 * @property {{use?: string[], allow?: string[], deny?: string[], mode?: string, definitions?: Array<Object>}} [tools]
 * @property {{maxIterations?: number, maxDepth?: number, timeoutMs?: number, maxElapsedMs?: number}} [limits]
 * @property {{path?: string|null, hash?: string}} [source]
 */

/**
 * A normalized script definition, as the loader emits it.
 * @typedef {Object} AgentScriptDefinition
 * @property {string} name
 * @property {string} [description]
 * @property {import('../../support/json.mjs').JsonSchema} [parameters]
 * @property {string} [scriptPath]
 * @property {string} [interpreter]
 * @property {number} [timeoutMs]
 * @property {boolean} [requiresApproval]
 * @property {string[]} [env]
 * @property {string} [baseDir]
 */

/**
 * The host-side object an agent file resolves against. Every key is optional:
 * a missing key is only an error when the file asks for the group that needs
 * it, and the error names the key.
 * @typedef {Object} AgentToolbox
 * @property {Object|null} [workspace] - A workspace handle (files/shell/artifacts).
 * @property {Function|{callback: Function, timeoutMs?: number}|null} [approval] - Shell/gated-tool callback.
 * @property {{store: Object}|null} [todos]
 * @property {{provider: Object, options?: Object}|null} [memory]
 * @property {{dir?: string, options?: Object}|null} [knowledge]
 * @property {Array<Object>|null} [skills] - Skill tool objects.
 * @property {{options?: Object}|null} [search]
 * @property {{options?: Object}|null} [scrape]
 * @property {{options?: Object}|null} [browser]
 * @property {{graph: Object, options?: Object}|null} [stateMachine]
 * @property {{agents: Array<Object>}|null} [delegation]
 * @property {Array<Object>} [tools] - Host tool objects, unprefixed.
 * @property {Record<string, Array<Object>>} [mcp] - server id → loaded MCP tools.
 * @property {Record<string, Array<Object>>} [acp] - agent id → loaded ACP tools.
 * @property {Record<string, Array<Object>>} [a2a] - peer id → loaded A2A tools.
 * @property {{strictDynamic?: boolean, trustReadOnlyHints?: boolean}} [options]
 */

/**
 * @typedef {Object} ResolvedToolset
 * @property {Array<Object>} tools - Tools to append to a session / a profile.
 * @property {Array<(session: Object) => Object>} actions - Component/delegation wiring, in order.
 * @property {string[]} names - Every granted runtime name.
 * @property {string[]} denied - Names removed by `deny`.
 * @property {string[]} groups - The expanded group names.
 * @property {string[]} warnings - Non-fatal resolution notes (unenumerated dynamic sources).
 * @property {Record<string, {source: string, owner: string|null, original: string}>} aliases - Prefixed name → origin.
 */

/** The toolbox keys a group may need, in error-message order.
 * @type {Record<string, string>} */
const NEED_LABELS = Object.freeze({
    workspace: 'workspace',
    approval: 'approval',
    todos: 'todos: { store }',
    memory: 'memory: { provider }',
    knowledge: 'knowledge: { dir }',
    skills: 'skills: [...]',
    search: 'search: { options }',
    scrape: 'scrape: { options }',
    browser: 'browser: { options }',
    stateMachine: 'stateMachine: { graph }',
    delegation: 'delegation: { agents }'
});


/**
 * @param {{reason: string, message: string, field?: string|null, path?: string|null}} arg0
 * @returns {AgentFileError}
 */
function agentError({ reason, message, field = null, path = null }) {
    return new AgentFileError({ message, options: { reason, field, path } });
}


/**
 * A wire-safe tool name: `[A-Za-z0-9_-]`, at most `agent_tool_name_max`, with a
 * short deterministic suffix when truncation is needed.
 * @param {{value: string}} arg0
 * @returns {string}
 */
export function sanitizeToolName({ value }) {
    return truncateToolName({ value: sanitizeSegment({ value }) });
}


/**
 * One namespace segment: `[A-Za-z0-9_-]`, no empty segment.
 * @param {{value: string}} arg0
 * @returns {string}
 */
function sanitizeSegment({ value }) {
    const cleaned = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return cleaned || 'tool';
}


/**
 * Caps a name at the wire limit, keeping a short deterministic suffix so two
 * long names do not collapse into one.
 * @param {{value: string}} arg0
 * @returns {string}
 */
function truncateToolName({ value }) {
    const base = String(value ?? '');
    const max = LIMITS.agent_tool_name_max;
    if (base.length <= max) return base;
    let hash = 0;
    for (let i = 0; i < base.length; i += 1) hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
    const suffix = hash.toString(36).slice(0, 6);
    return `${base.slice(0, Math.max(1, max - suffix.length - 1))}_${suffix}`;
}


/**
 * The namespaced name of an external tool. Native and host tools keep theirs.
 * The double underscore is the namespace separator and is never collapsed.
 * @param {{source: string, owner: string, name: string}} arg0
 * @returns {string}
 */
export function prefixExternalTool({ source, owner, name }) {
    const out = `${sanitizeSegment({ value: source })}__${sanitizeSegment({ value: owner })}__${sanitizeSegment({ value: name })}`;
    return truncateToolName({ value: out });
}


/**
 * The same prefixing, but `*` survives so a deny selector can stay a glob.
 * @param {{source: string, owner: string, pattern: string}} arg0
 * @returns {string}
 */
export function prefixExternalPattern({ source, owner, pattern }) {
    const ownerPart = sanitizeSegment({ value: owner });
    const namePart = String(pattern ?? '').replace(/[^A-Za-z0-9_*-]/g, '_') || '*';
    return `${sanitizeSegment({ value: source })}__${ownerPart}__${namePart}`;
}


/**
 * Builds the immutable toolbox. The object is a plain bag on purpose: it holds
 * live host objects (a workspace, clients), so it is not frozen deeply.
 * @param {AgentToolbox} [arg0]
 * @returns {AgentToolbox}
 */
export function createAgentToolbox({
    workspace = null,
    approval = null,
    todos = null,
    memory = null,
    knowledge = null,
    skills = null,
    search = null,
    scrape = null,
    browser = null,
    stateMachine = null,
    delegation = null,
    tools = [],
    mcp = {},
    acp = {},
    a2a = {},
    options = {}
} = {}) {
    return {
        workspace,
        approval,
        todos,
        memory,
        knowledge,
        skills: Array.isArray(skills) ? [...skills] : null,
        search,
        scrape,
        browser,
        stateMachine,
        delegation,
        tools: Array.isArray(tools) ? [...tools] : [],
        mcp: mcp ?? {},
        acp: acp ?? {},
        a2a: a2a ?? {},
        options: options ?? {}
    };
}


/**
 * @param {{toolbox: AgentToolbox, key: string}} arg0
 * @returns {boolean}
 */
function hasNeed({ toolbox, key }) {
    if (key === 'workspace') return Boolean(toolbox.workspace);
    if (key === 'approval') return Boolean(toolbox.approval);
    if (key === 'skills') return Array.isArray(toolbox.skills) && toolbox.skills.length > 0;
    if (key === 'delegation') return Boolean(toolbox.delegation && Array.isArray(toolbox.delegation.agents) && toolbox.delegation.agents.length > 0);
    return Boolean(/** @type {any} */ (toolbox)[key]);
}


/**
 * Splits one selector into `{ source, owner, pattern }`. `mcp:github/issues_*`
 * has owner `github`; `native:read` has owner null.
 * @param {{selector: string}} arg0
 * @returns {{source: string, owner: string|null, pattern: string}|null}
 */
export function parseSelector({ selector }) {
    const text = String(selector ?? '').trim();
    const at = text.indexOf(':');
    if (at <= 0) return null;
    const source = text.slice(0, at);
    const rest = text.slice(at + 1);
    if (!AGENT_SELECTOR_SOURCES.includes(source) || rest.length === 0) return null;
    const dynamic = source === 'mcp' || source === 'acp' || source === 'a2a';
    const slash = rest.indexOf('/');
    if (slash === -1) return { source, owner: dynamic ? rest : null, pattern: dynamic ? '*' : rest };
    return { source, owner: rest.slice(0, slash), pattern: rest.slice(slash + 1) };
}


/**
 * @param {{names: string[], patterns: string[]}} arg0
 * @returns {string[]}
 */
function matchNames({ names, patterns }) {
    const out = new Set();
    for (const pattern of patterns) {
        for (const name of names) {
            if (matchesGlob({ name, pattern })) out.add(name);
        }
    }
    return [...out];
}


/**
 * Resolves a spec against a toolbox.
 * @param {{spec: AgentSpecLike, toolbox?: AgentToolbox, allowDangerous?: boolean, mode?: 'session'|'profile'}} arg0
 * @returns {ResolvedToolset}
 */
export function resolveToolset({ spec, toolbox = {}, allowDangerous = false, mode = 'session' }) {
    const toolsSpec = spec?.tools ?? {};
    /** @type {string[]} */
    const useEntries = Array.isArray(toolsSpec.use) ? toolsSpec.use : [];
    /** @type {string[]} */
    const allowSelectors = Array.isArray(toolsSpec.allow) ? toolsSpec.allow : [];
    /** @type {string[]} */
    const denySelectorsRaw = Array.isArray(toolsSpec.deny) ? toolsSpec.deny : [];
    /** @type {Array<AgentScriptDefinition>} */
    const definitionEntries = Array.isArray(toolsSpec.definitions) ? /** @type {Array<AgentScriptDefinition>} */ (toolsSpec.definitions) : [];

    /** @type {AgentFileError[]} */
    const errors = [];
    /** @type {string[]} */
    const warnings = [];
    /** @type {Set<string>} */
    const groups = new Set();
    /** @type {Set<string>} */
    const includes = new Set();
    /** Catalog tool names granted by an action (they have no tool object here). */
    /** @type {Set<string>} */
    const granted = new Set();
    /** @type {Array<(session: Object) => Object>} */
    const actions = [];
    /** @type {Map<string, {origin: string, tool: Object}>} */
    const byName = new Map();
    /** @type {Record<string, {source: string, owner: string|null, original: string}>} */
    const aliases = {};

    // The loader gates these; the public resolver must too, because a caller can
    // hand it a spec object that never passed through `loadAgentFile`.
    if (toolsSpec.mode === 'bypassPermissions' && !allowDangerous) {
        errors.push(agentError({
            reason: 'agent_dangerous_mode',
            message: 'spec.tools.mode bypassPermissions requires allowDangerous.',
            field: 'spec.tools.mode'
        }));
    }
    for (const definition of definitionEntries) {
        if (definition.requiresApproval === false && !allowDangerous) {
            errors.push(agentError({
                reason: 'agent_dangerous_mode',
                message: `Script tool "${String(definition.name)}" runs without approval and requires allowDangerous.`,
                field: 'spec.tools.definitions'
            }));
        }
    }

    /**
     * @param {{name: string, field: string}} arg0
     */
    const addGroup = ({ name, field }) => {
        const expanded = expandAgentGroup({ name });
        if (!expanded) {
            if (AGENT_META_GROUPS.includes(name)) {
                if (!allowDangerous) {
                    errors.push(agentError({
                        reason: 'agent_dangerous_mode',
                        message: `Group "${name}" grants every tool and requires allowDangerous.`,
                        field
                    }));
                    return;
                }
                for (const entry of Object.keys(AGENT_TOOL_GROUPS)) {
                    if (!groups.has(entry)) addGroup({ name: entry, field });
                }
                return;
            }
            errors.push(agentError({
                reason: 'agent_invalid_field',
                message: `Unknown tool group "${name}".`,
                field
            }));
            return;
        }
        for (const groupName of expanded) {
            if (groups.has(groupName)) continue;
            const entry = AGENT_TOOL_GROUPS[groupName];
            const missing = entry.needs.filter((need) => !hasNeed({ toolbox, key: need }));
            if (missing.length > 0) {
                errors.push(agentError({
                    reason: 'agent_missing_group',
                    message: `Group "${groupName}" needs ${missing.map((need) => NEED_LABELS[need] ?? need).join(', ')} on the toolbox.`,
                    field
                }));
                continue;
            }
            if (mode === 'profile' && entry.wiring.kind !== 'workspace' && entry.wiring.kind !== 'none') {
                errors.push(agentError({
                    reason: 'agent_profile_unsupported',
                    message: `Group "${groupName}" wires a live component and cannot be used in a subagent profile.`,
                    field
                }));
                continue;
            }
            groups.add(groupName);
            for (const name of entry.tools) granted.add(name);
            if (groupName === 'skills' && Array.isArray(toolbox.skills)) {
                for (const skillTool of toolbox.skills) {
                    const skillName = /** @type {any} */ (skillTool)?.name;
                    if (typeof skillName === 'string' && skillName) granted.add(skillName);
                }
            }
            if (entry.wiring.kind === 'workspace') includes.add(/** @type {string} */ (entry.wiring.include));
            if (entry.wiring.kind === 'component') actions.push(componentAction({ groupName, toolbox }));
            if (entry.wiring.kind === 'delegation') actions.push(delegationAction({ toolbox }));
        }
    };

    for (const name of useEntries) {
        addGroup({ name: String(name), field: 'spec.tools.use' });
    }

    // allow — selectors add tools (and their owning group) on top of `use`.
    for (const selector of allowSelectors) {
        const bareWildcard = /^(native|host|skill|script|mcp|acp|a2a):\*(\/|$)/.test(String(selector).trim());
        if (bareWildcard && !allowDangerous) {
            errors.push(agentError({
                reason: 'agent_dangerous_mode',
                message: `${String(selector)} grants a whole namespace and requires allowDangerous.`,
                field: 'spec.tools.allow'
            }));
            continue;
        }
        if (String(selector).trim() === '*') {
            if (!allowDangerous) {
                errors.push(agentError({
                    reason: 'agent_dangerous_mode',
                    message: 'Bare * grants every tool and requires allowDangerous.',
                    field: 'spec.tools.allow'
                }));
                continue;
            }
            for (const entry of Object.keys(AGENT_TOOL_GROUPS)) addGroup({ name: entry, field: 'spec.tools.allow' });
            for (const tool of toolbox.tools ?? []) addTool({ tool, origin: 'host', aliases, byName, errors });
            for (const [owner, list] of Object.entries(toolbox.mcp ?? {})) addExternal({ source: 'mcp', owner, list, aliases, byName, errors, trustReadOnlyHints: toolbox.options?.trustReadOnlyHints === true });
            for (const [owner, list] of Object.entries(toolbox.acp ?? {})) addExternal({ source: 'acp', owner, list, aliases, byName, errors, trustReadOnlyHints: toolbox.options?.trustReadOnlyHints === true });
            for (const [owner, list] of Object.entries(toolbox.a2a ?? {})) addExternal({ source: 'a2a', owner, list, aliases, byName, errors, trustReadOnlyHints: toolbox.options?.trustReadOnlyHints === true });
            continue;
        }
        const parsed = parseSelector({ selector: String(selector) });
        if (!parsed) {
            errors.push(agentError({
                reason: 'agent_invalid_field',
                message: `Invalid tool selector "${String(selector)}".`,
                field: 'spec.tools.allow'
            }));
            continue;
        }
        resolveSelector({ parsed, spec, toolbox, allowDangerous, mode, addGroup, includes, actions, aliases, byName, errors, warnings });
    }

    // Workspace tools are materialized once, with the union of requested includes.
    if (includes.size > 0 && toolbox.workspace) {
        const buildWorkspace = () => createWorkspaceTools({
            workspace: /** @type {import('../workspace/manager.mjs').WorkspaceHandleLike} */ (toolbox.workspace),
            approvalCallback: toolbox.approval ?? null,
            include: [...includes],
            permissionMode: /** @type {import('../permissions.mjs').PermissionMode} */ (toolsSpec.mode ?? 'default')
        });
        /** @type {ReturnType<typeof createWorkspaceTools>} */
        let built;
        try {
            built = buildWorkspace();
        } catch (cause) {
            errors.push(agentError({
                reason: 'agent_invalid_field',
                message: `The toolbox workspace was refused: ${/** @type {any} */ (cause)?.message ?? 'invalid workspace'}`,
                field: 'toolbox.workspace'
            }));
            built = /** @type {any} */ ({ contextTools: null, shellTool: null, artifactTool: null });
        }
        for (const tool of [built.shellTool, built.artifactTool, ...(built.contextTools ?? [])]) {
            if (tool) addTool({ tool, origin: 'native', aliases, byName, errors });
        }
    }

    // Script definitions selected by `script:` — and every definition when no
    // selector narrowed them? No: a definition is inert until selected, except
    // that `script:*` is the explicit opt-in. A definition with no selector is
    // granted: the author declared it inside the file.
    const definitions = definitionEntries;
    const scriptSelectors = allowSelectors
        .map((selector) => parseSelector({ selector: String(selector) }))
        .filter((parsed) => parsed?.source === 'script');
    const selectedScripts = scriptSelectors.length === 0
        ? definitions
        : definitions.filter((definition) => scriptSelectors.some((parsed) => (
            matchesGlob({ name: definition.name, pattern: /** @type {any} */ (parsed).pattern })
        )));
    if (scriptSelectors.length > 0 && selectedScripts.length === 0) {
        errors.push(agentError({
            reason: 'agent_invalid_field',
            message: `script selector matches no declared definition. Declared: ${definitions.map((entry) => entry.name).join(', ') || 'none'}.`,
            field: 'spec.tools.allow'
        }));
    }
    for (const definition of selectedScripts) {
        const tool = createScriptTool({ definition: { ...definition, envKeys: definition.env ?? [] } });
        addTool({ tool, origin: 'script', aliases, byName, errors });
    }

    // deny — always wins, over final names.
    const denySelectors = denySelectorsRaw
        .map((selector) => ({ raw: String(selector).trim(), parsed: parseSelector({ selector: String(selector) }) }));
    const denied = new Set();
    const allNames = [...new Set([...byName.keys(), ...granted])];
    for (const { raw, parsed } of denySelectors) {
        if (raw === '*') {
            for (const name of allNames) denied.add(name);
            continue;
        }
        if (!parsed) continue;
        const names = denyNamesFor({ parsed, toolbox, allNames, spec });
        for (const name of names) denied.add(name);
        if (names.length > 0) continue;
        const dynamic = parsed.source === 'mcp' || parsed.source === 'acp' || parsed.source === 'a2a';
        const sourceMap = parsed.source === 'mcp' ? toolbox.mcp : parsed.source === 'acp' ? toolbox.acp : toolbox.a2a;
        const registered = parsed.owner !== null && Boolean(sourceMap?.[parsed.owner]);
        const enumerable = !dynamic || (registered && (sourceMap?.[/** @type {string} */ (parsed.owner)] ?? []).length > 0);
        if (enumerable || toolbox.options?.strictDynamic === true) {
            errors.push(agentError({
                reason: 'agent_invalid_field',
                message: `deny:${parsed.owner ? `${parsed.owner}/${parsed.pattern}` : parsed.pattern} matches nothing. A deny typo must not pass silently.`,
                field: 'spec.tools.deny'
            }));
        } else {
            warnings.push(`deny:${parsed.owner ? `${parsed.owner}/${parsed.pattern}` : parsed.pattern} matches no advertised tool yet; the source is not enumerated.`);
        }
    }

    if (errors.length > 0) {
        const first = /** @type {AgentFileError} */ (errors[0]);
        first.reasons = errors.length === 1
            ? first.reasons
            : [...new Set(errors.map((error) => error.reason).filter((reason) => typeof reason === 'string'))];
        first.issues = errors.map((error) => ({
            reason: String(error.reason ?? 'agent_invalid_field'),
            field: error.field ?? null,
            line: error.line ?? null,
            column: error.column ?? null
        }));
        first.message = errors.map((error) => error.message).join(' ');
        throw first;
    }

    const finalTools = [...byName.entries()].filter(([name]) => !denied.has(name)).map(([, entry]) => entry.tool);
    const finalNames = [...new Set([
        ...granted,
        ...finalTools.map((tool) => /** @type {any} */ (tool).name).filter((name) => typeof name === 'string')
    ])].filter((name) => !denied.has(name));
    /** @type {Record<string, {source: string, owner: string|null, original: string}>} */
    const finalAliases = {};
    for (const name of finalNames) {
        if (aliases[name]) finalAliases[name] = aliases[name];
    }
    return {
        tools: finalTools,
        // A deny-all leaves no callable tool; wiring a component would announce
        // tools the model can never call (the advertise-only-what-works rule).
        actions: finalNames.length > 0 ? actions : [],
        names: finalNames,
        denied: [...denied],
        groups: [...groups],
        warnings,
        aliases: finalAliases
    };
}


/**
 * @param {{groupName: string, toolbox: AgentToolbox}} arg0
 * @returns {(session: Object) => Object}
 */
function componentAction({ groupName, toolbox }) {
    return (session) => {
        if (groupName === 'todos') return /** @type {any} */ (session).withTodos({ store: /** @type {any} */ (toolbox.todos).store });
        if (groupName === 'memory') return /** @type {any} */ (session).withMemory({ provider: /** @type {any} */ (toolbox.memory).provider, options: /** @type {any} */ (toolbox.memory).options ?? {} });
        if (groupName === 'knowledge') return /** @type {any} */ (session).withKnowledge({ dir: /** @type {any} */ (toolbox.knowledge).dir ?? '.knowledge', ...(/** @type {any} */ (toolbox.knowledge).options ?? {}) });
        if (groupName === 'skills') return /** @type {any} */ (session).withSkills({ skills: /** @type {any} */ (toolbox.skills) });
        if (groupName === 'search') return /** @type {any} */ (session).withWebSearch({ options: /** @type {any} */ (toolbox.search).options ?? {} });
        if (groupName === 'scrape') return /** @type {any} */ (session).withWebScrape({ options: /** @type {any} */ (toolbox.scrape).options ?? {} });
        if (groupName === 'browser') return /** @type {any} */ (session).withBrowser({ options: /** @type {any} */ (toolbox.browser).options ?? {} });
        if (groupName === 'state_machine') return /** @type {any} */ (session).withStateMachine({ graph: /** @type {any} */ (toolbox.stateMachine).graph, options: /** @type {any} */ (toolbox.stateMachine).options ?? {} });
        return session;
    };
}


/**
 * @param {{toolbox: AgentToolbox}} arg0
 * @returns {(session: Object) => Object}
 */
function delegationAction({ toolbox }) {
    return (session) => /** @type {any} */ (session).withTaskAgents({ agents: /** @type {any} */ (toolbox.delegation).agents });
}


/**
 * @param {{tool: Object, origin: string, aliases: Record<string, any>, byName: Map<string, {origin: string, tool: Object}>, errors: AgentFileError[]}} arg0
 */
function addTool({ tool, origin, aliases, byName, errors }) {
    const name = /** @type {any} */ (tool)?.name;
    if (typeof name !== 'string' || !name) {
        errors.push(agentError({ reason: 'agent_invalid_field', message: 'A resolved tool has no name.' }));
        return;
    }
    const existing = byName.get(name);
    if (existing) {
        errors.push(agentError({
            reason: 'agent_duplicate_tool',
            message: `Tool name "${name}" is provided by both ${existing.origin} and ${origin}.`
        }));
        return;
    }
    byName.set(name, { origin, tool });
    aliases[name] = { source: origin, owner: null, original: name };
}


/**
 * @param {{source: string, owner: string, list: Array<Object>, aliases: Record<string, any>, byName: Map<string, {origin: string, tool: Object}>, errors: AgentFileError[], trustReadOnlyHints?: boolean}} arg0
 */
function addExternal({ source, owner, list, aliases, byName, errors, trustReadOnlyHints = false }) {
    for (const tool of Array.isArray(list) ? list : []) {
        const original = /** @type {any} */ (tool)?.name;
        if (typeof original !== 'string' || !original) continue;
        const name = prefixExternalTool({ source, owner, name: original });
        // A remote tool is gated at the boundary unless the HOST trusts the
        // source's own read-only claim. `idempotent: true` on an MCP tool comes
        // from the remote's `readOnlyHint` (untrusted), so it is honoured only
        // when `trustReadOnlyHints` is set. ACP/A2A carry no hint at all.
        const remote = source === 'mcp' || source === 'acp' || source === 'a2a';
        const trustedReadOnly = remote && trustReadOnlyHints && source === 'mcp'
            && /** @type {any} */ (tool).idempotent === true;
        const renamed = remote && !trustedReadOnly && !/** @type {any} */ (tool).requiresApproval
            ? { ...tool, name, requiresApproval: true }
            : { ...tool, name };
        const existing = byName.get(name);
        if (existing) {
            errors.push(agentError({
                reason: 'agent_duplicate_tool',
                message: `Tool name "${name}" is provided by both ${existing.origin} and ${source}:${owner}.`
            }));
            continue;
        }
        byName.set(name, { origin: `${source}:${owner}`, tool: renamed });
        aliases[name] = { source, owner, original };
    }
}


/**
 * @param {{parsed: {source: string, owner: string|null, pattern: string}, spec: Object, toolbox: AgentToolbox, allowDangerous: boolean, mode: string, addGroup: Function, includes: Set<string>, actions: Array<Function>, aliases: Record<string, any>, byName: Map<string, {origin: string, tool: Object}>, errors: AgentFileError[], warnings: string[]}} arg0
 */
function resolveSelector({ parsed, spec, toolbox, allowDangerous, mode, addGroup, includes, actions, aliases, byName, errors, warnings }) {
    const { source, owner, pattern } = parsed;
    const field = 'spec.tools.allow';
    if (source === 'native') {
        const catalogNames = Object.values(AGENT_TOOL_GROUPS).flatMap((entry) => [...entry.tools]);
        const matched = matchNames({ names: catalogNames, patterns: [pattern] });
        if (matched.length === 0) {
            errors.push(agentError({ reason: 'agent_invalid_field', message: `native:${pattern} matches no SDK tool.`, field }));
            return;
        }
        for (const groupName of Object.keys(AGENT_TOOL_GROUPS)) {
            if (AGENT_TOOL_GROUPS[groupName].tools.some((tool) => matched.includes(tool))) {
                addGroup({ name: groupName, field });
            }
        }
        return;
    }
    if (source === 'host') {
        const matched = matchNames({ names: (toolbox.tools ?? []).map((tool) => /** @type {any} */ (tool)?.name).filter(Boolean), patterns: [pattern] });
        if (matched.length === 0) {
            errors.push(agentError({ reason: 'agent_invalid_field', message: `host:${pattern} matches no host tool.`, field }));
            return;
        }
        for (const tool of toolbox.tools ?? []) {
            if (matched.includes(/** @type {any} */ (tool)?.name)) addTool({ tool, origin: 'host', aliases, byName, errors });
        }
        return;
    }
    if (source === 'script') return; // definitions are handled in bulk
    if (source === 'skill') {
        const matched = matchNames({ names: (toolbox.skills ?? []).map((tool) => /** @type {any} */ (tool)?.name).filter(Boolean), patterns: [pattern] });
        if (matched.length === 0) {
            errors.push(agentError({ reason: 'agent_invalid_field', message: `skill:${pattern} matches no loaded skill.`, field }));
            return;
        }
        for (const tool of toolbox.skills ?? []) {
            if (matched.includes(/** @type {any} */ (tool)?.name)) addTool({ tool, origin: 'skill', aliases, byName, errors });
        }
        return;
    }
    const sourceMap = source === 'mcp' ? toolbox.mcp : source === 'acp' ? toolbox.acp : toolbox.a2a;
    const servers = Object.keys(sourceMap ?? {});
    const ownerKeys = owner === '*' ? servers : (owner !== null && servers.includes(owner) ? [owner] : []);
    if (ownerKeys.length === 0) {
        const lenient = (source === 'a2a' || owner === '*') && toolbox.options?.strictDynamic !== true;
        if (lenient) {
            warnings.push(`${source}:${owner ?? pattern} names no registered source yet; skipped.`);
            return;
        }
        errors.push(agentError({
            reason: 'agent_missing_group',
            message: `${source}:${owner ?? pattern} names no registered source. Registered: ${servers.join(', ') || 'none'}.`,
            field
        }));
        return;
    }
    let grantedAny = false;
    for (const key of ownerKeys) {
        const list = sourceMap?.[key] ?? [];
        const entries = list
            .filter((tool) => typeof (/** @type {any} */ (tool)?.name) === 'string' && /** @type {any} */ (tool).name)
            .map((tool) => ({ tool, raw: /** @type {any} */ (tool).name, safe: sanitizeSegment({ value: /** @type {any} */ (tool).name }) }));
        const matched = new Set([
            ...matchNames({ names: entries.map((entry) => entry.raw), patterns: [pattern] }),
            ...matchNames({ names: entries.map((entry) => entry.safe), patterns: [pattern] })
        ]);
        if (matched.size === 0) continue;
        grantedAny = true;
        addExternal({
            source,
            owner: key,
            list: entries.filter((entry) => matched.has(entry.raw) || matched.has(entry.safe)).map((entry) => entry.tool),
            aliases,
            byName,
            errors,
            trustReadOnlyHints: toolbox.options?.trustReadOnlyHints === true
        });
    }
    if (!grantedAny) {
        const enumerable = ownerKeys.some((key) => (sourceMap?.[key] ?? []).length > 0);
        if (!enumerable && toolbox.options?.strictDynamic !== true) {
            warnings.push(`${source}:${owner}/${pattern} matches no advertised tool yet; the source is not enumerated.`);
            return;
        }
        errors.push(agentError({
            reason: 'agent_invalid_field',
            message: `${source}:${owner}/${pattern} matches no advertised tool.`,
            field
        }));
    }
}


/**
 * @param {{parsed: {source: string, owner: string|null, pattern: string}, toolbox: AgentToolbox, allNames: string[], spec: Object}} arg0
 * @returns {string[]}
 */
function denyNamesFor({ parsed, toolbox, allNames, spec }) {
    const { source, owner, pattern } = parsed;
    if (source === 'native') {
        const catalogNames = Object.values(AGENT_TOOL_GROUPS).flatMap((entry) => [...entry.tools]);
        return matchNames({ names: [...new Set([...catalogNames, ...allNames])], patterns: [pattern] });
    }
    if (source === 'host' || source === 'skill' || source === 'script') {
        return matchNames({ names: allNames, patterns: [pattern] });
    }
    if (owner === null) {
        return matchNames({ names: allNames, patterns: [`${source}__*`] });
    }
    return matchNames({ names: allNames, patterns: [prefixExternalPattern({ source, owner, pattern })] });
}
