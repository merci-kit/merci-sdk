// @ts-check


/**
 * @file The agent-definition tool catalog: one frozen table of the groups a
 * `*.agent.yaml` file may request, the concrete tool names each one yields, and
 * the host object it needs.
 * @version 0.12.0
 *
 * @description
 * A group is the beginner-facing half of the tool model (`spec.tools.use`); a
 * selector (`mcp:github/issues_*`, `host:write_file`) is the power-facing half.
 * Both resolve through this table, so a group and a selector can never disagree
 * about which tools exist.
 *
 * The table is data, not behaviour: `lib/agentic/agents/toolbox.mjs` owns the
 * wiring, and `scripts/check-agent-catalog.mjs` fails when a capability or tool
 * constant in the SDK is missing from it. Adding a capability without adding a
 * group is therefore a red CI, not a silent gap.
 *
 * `load_artifacts` is deliberately absent: the constant and its announcement
 * exist, but no tool registers it (`save_artifact` is the whole artifacts
 * surface today). The catalog lists what a session can actually call.
 */
import {
    BROWSER_TOOL_NAME,
    KNOWLEDGE_PATCH_TOOL_NAME,
    KNOWLEDGE_QUERY_TOOL_NAME,
    LOAD_MEMORY_TOOL_NAME,
    LOAD_SKILLS_TOOL_NAME,
    LOAD_TODOS_TOOL_NAME,
    MANAGE_TODOS_TOOL_NAME,
    RUN_STATE_MACHINE_TOOL_NAME,
    SAVE_ARTIFACT_TOOL_NAME,
    SAVE_MEMORY_TOOL_NAME,
    WEB_SCRAPE_TOOL_NAME,
    WEB_SEARCH_TOOL_NAME
} from '../../core/constants/index.mjs';


/**
 * One group. `wiring` names what the toolbox must call: `workspace` with an
 * `include` entry, a component builder (`todos`, `memory`, `knowledge`,
 * `skills`, `search`, `scrape`, `browser`, `stateMachine`), `delegation` (the
 * `task` tool appears when profiles are registered), or `none` for tools the
 * host already supplied.
 * @typedef {Object} AgentToolGroup
 * @property {readonly string[]} tools - The runtime tool names this group yields.
 * @property {readonly string[]} needs - Toolbox keys the host must provide.
 * @property {{kind: 'workspace'|'component'|'delegation'|'none', include?: string, method?: string}} wiring
 * @property {string} summary - One line for error messages and docs.
 */

/**
 * @param {{tools: readonly string[], needs: readonly string[], wiring: AgentToolGroup['wiring'], summary: string}} spec
 * @returns {AgentToolGroup}
 */
function group({ tools, needs, wiring, summary }) {
    return Object.freeze({
        tools: Object.freeze([...tools]),
        needs: Object.freeze([...needs]),
        wiring: Object.freeze({ ...wiring }),
        summary
    });
}


/**
 * The groups a file may name in `spec.tools.use`. Every entry is satisfied by
 * an existing public builder; none of them needs a new engine.
 * @type {Readonly<Record<string, AgentToolGroup>>}
 */
export const AGENT_TOOL_GROUPS = Object.freeze({
    files: group({
        tools: ['read', 'grep', 'glob'],
        needs: ['workspace'],
        wiring: { kind: 'workspace', include: 'context' },
        summary: 'Read-only workspace access: read, grep, glob.'
    }),
    shell: group({
        tools: ['execute_shell_command'],
        needs: ['workspace', 'approval'],
        wiring: { kind: 'workspace', include: 'shell' },
        summary: 'A gated shell bound to the workspace root.'
    }),
    artifacts: group({
        tools: [SAVE_ARTIFACT_TOOL_NAME],
        needs: ['workspace'],
        wiring: { kind: 'workspace', include: 'artifacts' },
        summary: 'Persist a deliverable to the artifacts directory.'
    }),
    todos: group({
        tools: [LOAD_TODOS_TOOL_NAME, MANAGE_TODOS_TOOL_NAME],
        needs: ['todos'],
        wiring: { kind: 'component', method: 'withTodos' },
        summary: 'A todo list shared with the run.'
    }),
    memory: group({
        tools: [LOAD_MEMORY_TOOL_NAME, SAVE_MEMORY_TOOL_NAME],
        needs: ['memory'],
        wiring: { kind: 'component', method: 'withMemory' },
        summary: 'Long-term memory load and save.'
    }),
    knowledge: group({
        tools: [KNOWLEDGE_QUERY_TOOL_NAME, KNOWLEDGE_PATCH_TOOL_NAME],
        needs: ['knowledge'],
        wiring: { kind: 'component', method: 'withKnowledge' },
        summary: 'Query and patch the knowledge graph.'
    }),
    skills: group({
        tools: [LOAD_SKILLS_TOOL_NAME],
        needs: ['skills'],
        wiring: { kind: 'component', method: 'withSkills' },
        summary: 'A skills library; loaded skills add their own tools.'
    }),
    search: group({
        tools: [WEB_SEARCH_TOOL_NAME],
        needs: ['search'],
        wiring: { kind: 'component', method: 'withWebSearch' },
        summary: 'Web search through the configured engine.'
    }),
    scrape: group({
        tools: [WEB_SCRAPE_TOOL_NAME],
        needs: ['scrape'],
        wiring: { kind: 'component', method: 'withWebScrape' },
        summary: 'Fetch and extract one page.'
    }),
    browser: group({
        tools: [BROWSER_TOOL_NAME],
        needs: ['browser'],
        wiring: { kind: 'component', method: 'withBrowser' },
        summary: 'Read-only headless browser.'
    }),
    delegate: group({
        tools: ['task'],
        needs: ['delegation'],
        wiring: { kind: 'delegation' },
        summary: 'Delegate to a registered subagent profile.'
    }),
    state_machine: group({
        tools: [RUN_STATE_MACHINE_TOOL_NAME],
        needs: ['stateMachine'],
        wiring: { kind: 'component', method: 'withStateMachine' },
        summary: 'Run a verified state machine graph.'
    })
});


/**
 * Beginner aliases: a readable umbrella that expands to real groups.
 * `all` is not here — it is a meta-group that requires `allowDangerous`.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const AGENT_TOOL_GROUP_ALIASES = Object.freeze({
    web: Object.freeze(['search', 'scrape'])
});


/** Groups that grant every tool the host can satisfy; dangerous by design. */
export const AGENT_META_GROUPS = Object.freeze(['all']);


/** The selector namespaces a file may use in `allow` / `deny`. */
export const AGENT_SELECTOR_SOURCES = Object.freeze([
    'native', 'host', 'skill', 'script', 'mcp', 'acp', 'a2a'
]);


/**
 * Expands one `use` entry to real group names. Returns null for an unknown
 * name so the caller can raise its own `AgentFileError` with the file position.
 * @param {{name: string}} arg0
 * @returns {string[]|null}
 */
export function expandAgentGroup({ name }) {
    const key = String(name ?? '').trim();
    if (Object.hasOwn(AGENT_TOOL_GROUPS, key)) return [key];
    const alias = AGENT_TOOL_GROUP_ALIASES[key];
    return alias ? [...alias] : null;
}


/**
 * The tool names a `use` entry yields, after alias expansion. Null when the
 * name is unknown; `all` returns every group's tools (the caller must gate it).
 * @param {{name: string}} arg0
 * @returns {string[]|null}
 */
export function agentGroupToolNames({ name }) {
    const key = String(name ?? '').trim();
    if (AGENT_META_GROUPS.includes(key)) {
        return Object.values(AGENT_TOOL_GROUPS).flatMap((entry) => [...entry.tools]);
    }
    const names = expandAgentGroup({ name: key });
    return names ? names.flatMap((groupName) => [...AGENT_TOOL_GROUPS[groupName].tools]) : null;
}
