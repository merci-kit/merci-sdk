// @ts-check


/**
 * @file Public surface of `merci-sdk/agents`: load a `*.agent.yaml`, resolve
 * its tool model against a host toolbox, then run it or register it.
 * @version 0.12.0
 */
export { loadAgentFile, loadAgentDirectory } from './load.mjs';
export { AGENT_API_VERSION, AGENT_KIND, AGENT_FILE_REASONS } from './spec.mjs';
export {
    AGENT_META_GROUPS,
    AGENT_SELECTOR_SOURCES,
    AGENT_TOOL_GROUPS,
    AGENT_TOOL_GROUP_ALIASES,
    agentGroupToolNames,
    expandAgentGroup
} from './catalog.mjs';
export {
    createAgentToolbox,
    parseSelector,
    prefixExternalPattern,
    prefixExternalTool,
    resolveToolset,
    sanitizeToolName
} from './toolbox.mjs';
export { applyAgentSpec, toTaskAgent } from './apply.mjs';
