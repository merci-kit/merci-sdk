// @ts-check


/**
 * @file The two agent-definition consumers: a runnable session and a delegated
 * subagent profile.
 * @version 0.12.0
 *
 * @description
 * One `AgentSpec`, one `resolveToolset`, two adapters. `applyAgentSpec` wires a
 * live session (prompt, permissions, component actions, tools);
 * `toTaskAgent` builds the profile `withTaskAgents` accepts. Because both go
 * through the same resolution, a file cannot grant different tools depending on
 * how it is run.
 *
 * A profile is a tool belt, not a session: component groups (`todos`, `memory`,
 * `knowledge`, `skills`, `search`, `scrape`, `browser`, `state_machine`,
 * `delegate`) need a live session's step blocks and are refused there with
 * `agent_profile_unsupported` instead of being silently dropped.
 */
import { AgentFileError, ConfigurationError } from '../../core/errors.mjs';
import { getToolModel, resolveRole } from '../../support/utils.mjs';
import { resolveToolset } from './toolbox.mjs';


/**
 * The subset of a loaded spec this module reads.
 * @typedef {Object} AgentSpecLike
 * @property {string} name
 * @property {string} description
 * @property {string} instructions
 * @property {{kind: 'role'|'id', value: string}} [model]
 * @property {{use?: string[], allow?: string[], deny?: string[], mode?: string, definitions?: Array<{name?: string, scriptHash?: string}>}} [tools]
 * @property {{maxIterations?: number, maxDepth?: number, timeoutMs?: number, maxElapsedMs?: number}} [limits]
 * @property {{path?: string|null, hash?: string}} [source]
 */

/**
 * The fluent session surface `applyAgentSpec` needs.
 * @typedef {Object} AgentSessionLike
 * @property {(content: string) => AgentSessionLike} withSystemMessage
 * @property {(rules: {allow?: string[], deny?: string[], mode?: string}) => AgentSessionLike} withPermissions
 * @property {(arg0: {patterns: string[]}) => AgentSessionLike} withToolAllowlist
 * @property {(arg0: {tools: Array<Object>, replace?: boolean}) => AgentSessionLike} withAdditionalTools
 * @property {{allow?: string[], deny?: string[], mode?: string}} [_permissionRules]
 */

/**
 * The more restrictive of two permission modes. A file may narrow approval,
 * never widen it: a host running `bypassPermissions` stays there, and a host on
 * `default` cannot be lifted to `acceptEdits` by a file.
 * @param {{host?: string, file?: string}} arg0
 * @returns {'default'|'acceptEdits'|'bypassPermissions'}
 */
function stricterMode({ host = 'default', file = 'default' }) {
    const order = ['default', 'acceptEdits', 'bypassPermissions'];
    const hostAt = order.indexOf(host);
    const fileAt = order.indexOf(file);
    return /** @type {'default'|'acceptEdits'|'bypassPermissions'} */ (
        order[Math.min(hostAt < 0 ? 0 : hostAt, fileAt < 0 ? 0 : fileAt)] ?? 'default'
    );
}

/**
 * Applies a spec to an existing session and returns it (fluent).
 * @param {{session: AgentSessionLike, spec: AgentSpecLike, toolbox?: Object, allowDangerous?: boolean}} arg0
 * @returns {AgentSessionLike} The session.
 */
export function applyAgentSpec({ session, spec, toolbox = {}, allowDangerous = false }) {
    if (!session || typeof session.withSystemMessage !== 'function' || typeof session.withPermissions !== 'function') {
        throw new ConfigurationError({ message: 'applyAgentSpec requires a chat session (client.session(model)).', options: { option: 'session' } });
    }
    if (typeof session.withAdditionalTools !== 'function' || typeof session.withToolAllowlist !== 'function') {
        throw new ConfigurationError({ message: 'applyAgentSpec requires a session with withToolAllowlist and withAdditionalTools (MerciSDK >= the agent-file release).', options: { option: 'session' } });
    }
    const resolved = resolveToolset({ spec, toolbox, allowDangerous, mode: 'session' });
    const hostRules = /** @type {any} */ (session)._permissionRules ?? { allow: [], deny: [], mode: 'default' };
    const mode = stricterMode({ host: hostRules.mode, file: spec?.tools?.mode });

    session.withSystemMessage(spec?.instructions ?? '');
    // Preserve the host's own rules: a file may not delete a host deny list.
    session.withPermissions({ allow: hostRules.allow ?? [], deny: hostRules.deny ?? [], mode });
    // The file's grant is an intersection, not a replacement: each layer must
    // admit a tool, so this can narrow the host but never widen it. An empty
    // grant denies everything (an empty allow list would mean "no restriction").
    session.withToolAllowlist({ patterns: resolved.names.length > 0 ? resolved.names : ['__none__'] });
    for (const action of resolved.actions) action(session);
    if (resolved.tools.length > 0) {
        try {
            session.withAdditionalTools({ tools: resolved.tools, replace: false });
        } catch (cause) {
            throw new AgentFileError({
                message: `A resolved tool collides with a tool the session already had: ${/** @type {any} */ (cause)?.message ?? 'duplicate tool'}`,
                options: { reason: 'agent_duplicate_tool', path: spec?.source?.path ?? null, cause }
            });
        }
    }
    return session;
}


/**
 * Resolves the file's model shorthand to a concrete model id. `default` and
 * `tool` are agent-file aliases, not client roles (`generative`/`embedding`/
 * `decision` are the roles `resolveRole` knows).
 * @param {{spec: AgentSpecLike}} arg0
 * @returns {string}
 */
function resolveSpecModel({ spec }) {
    if (spec.model?.kind === 'id') return String(spec.model.value);
    const value = spec.model?.value ?? 'default';
    if (value === 'tool') {
        const { provider } = resolveRole({ role: 'generative' });
        const model = getToolModel({ provider });
        if (!model) throw new ConfigurationError({ message: 'No tool model is configured for model: tool.', options: { option: 'model' } });
        return model;
    }
    if (value === 'decision') return resolveRole({ role: 'decision' }).model;
    return resolveRole({ role: 'generative' }).model;
}

/**
 * Builds the `TaskAgent` profile for `withTaskAgents`.
 * @param {{spec: AgentSpecLike, toolbox?: Object, allowDangerous?: boolean, model?: string|null}} arg0
 * @returns {Record<string, unknown>} A profile object.
 */
export function toTaskAgent({ spec, toolbox = {}, allowDangerous = false, model = null }) {
    if (!spec || typeof spec.name !== 'string' || !spec.name) {
        throw new ConfigurationError({ message: 'toTaskAgent requires a loaded agent spec.', options: { option: 'spec' } });
    }
    const resolved = resolveToolset({ spec, toolbox, allowDangerous, mode: 'profile' });
    const chosenModel = model ?? resolveSpecModel({ spec });

    /** @type {Record<string, unknown>} */
    const profile = {
        name: spec.name,
        description: spec.description,
        model: chosenModel,
        systemPrompt: spec.instructions,
        tools: resolved.tools,
        toolNames: resolved.names,
        definitionPath: spec.source?.path ?? null,
        definitionHash: spec.source?.hash ?? null,
        scriptHashes: (spec.tools?.definitions ?? []).map((definition) => ({
            name: definition.name,
            scriptHash: definition.scriptHash
        }))
    };
    const limits = spec.limits ?? {};
    if (limits.maxIterations !== undefined) profile.maxIterations = limits.maxIterations;
    if (limits.maxDepth !== undefined) profile.maxDepth = limits.maxDepth;
    if (limits.timeoutMs !== undefined) profile.timeoutMs = limits.timeoutMs;
    if (limits.maxElapsedMs !== undefined) profile.maxElapsedMs = limits.maxElapsedMs;
    return profile;
}
