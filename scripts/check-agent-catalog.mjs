#!/usr/bin/env node
// @ts-check


/**
 * @file The agent-catalog drift gate.
 * @version 0.12.0
 *
 * @description
 * `lib/agentic/agents/catalog.mjs` is the one table that turns a beginner group
 * (`use: [files]`) and a power selector (`mcp:github/issues_*`) into real tool
 * names. A hand-written table rots the first time a capability ships, so this
 * gate fails when the SDK and the catalog disagree:
 *
 *   C1 every `CAPABILITY` id maps to a group (a new capability must be added
 *      to the table below, or CI explains which one is missing);
 *   C2 every `*_TOOL_NAME` constant is referenced by a group, or explicitly
 *      exempt with a reason;
 *   C3 every workspace `include` group (`context`, `shell`, `artifacts`) is
 *      wired by some group;
 *   C4 every tool name is a plain identifier (the wire rejects anything else);
 *   C5 every alias resolves to real groups and the `all` meta-group stays
 *      non-empty.
 *
 * Run: `node scripts/check-agent-catalog.mjs` (or `pnpm run check:agents`).
 * Exit 1 when the catalog and the SDK disagree.
 */
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const CATALOG_PATH = join(ROOT, 'lib', 'agentic', 'agents', 'catalog.mjs');

/**
 * Capability id → the group that satisfies it. A new `CAPABILITY` entry that is
 * absent here fails C1; that is the point.
 * @type {Record<string, string>}
 */
const CAPABILITY_GROUPS = {
    skills: 'skills',
    memory: 'memory',
    todos: 'todos',
    state_machine: 'state_machine',
    task: 'delegate',
    web_search: 'search',
    web_scrape: 'scrape',
    browser: 'browser',
    artifacts: 'artifacts',
    knowledge: 'knowledge'
};

/**
 * Tool-name constants that are deliberately not a group member, with the reason.
 * `load_artifacts` has a constant and an announcement but no tool implementation
 * in this release; `tool_search` is injected by the session builder, never
 * granted by a file.
 * @type {Record<string, string>}
 */
const EXEMPT_TOOL_NAMES = {
    load_artifacts: 'constant without a registered tool in this release',
    tool_search: 'injected by the chat session builder when a deferred tool exists',
    plan_exit: 'plan-mode tool composed by the host through withPlan/withPlanTools'
};

/** @type {string[]} */
const errors = [];

/**
 * @param {{message: string}} arg0
 */
function fail({ message }) {
    errors.push(message);
}

const constants = await import(join(ROOT, 'lib', 'core', 'constants', 'index.mjs'));
const catalog = await import(CATALOG_PATH);

const groups = catalog.AGENT_TOOL_GROUPS;
const aliases = catalog.AGENT_TOOL_GROUP_ALIASES;
const metaGroups = catalog.AGENT_META_GROUPS;

if (!groups || typeof groups !== 'object' || Object.keys(groups).length === 0) {
    console.error('agent catalog — AGENT_TOOL_GROUPS is missing or empty');
    process.exit(1);
}

// C1 — every capability has a group.
for (const capabilityId of Object.values(constants.CAPABILITY ?? {})) {
    const groupName = CAPABILITY_GROUPS[capabilityId];
    if (!groupName) {
        fail({ message: `C1 capability "${capabilityId}" has no group mapping in scripts/check-agent-catalog.mjs` });
    } else if (!groups[groupName]) {
        fail({ message: `C1 capability "${capabilityId}" maps to missing group "${groupName}"` });
    }
}
for (const capabilityId of Object.keys(CAPABILITY_GROUPS)) {
    if (!Object.values(constants.CAPABILITY ?? {}).includes(capabilityId)) {
        fail({ message: `C1 CAPABILITY_GROUPS names "${capabilityId}", which is not a CAPABILITY id` });
    }
}

// C2 — every tool-name constant is represented or exempt.
const catalogToolNames = new Set(
    Object.values(groups).flatMap((entry) => [...entry.tools])
);
for (const [key, value] of Object.entries(constants)) {
    if (!key.endsWith('_TOOL_NAME')) continue;
    if (catalogToolNames.has(value)) continue;
    if (EXEMPT_TOOL_NAMES[value]) continue;
    fail({ message: `C2 ${key} ("${value}") is not referenced by any group and has no exemption` });
}
for (const value of Object.keys(EXEMPT_TOOL_NAMES)) {
    if (!Object.values(constants).includes(value)) {
        fail({ message: `C2 exemption "${value}" is not a tool-name constant anymore` });
    }
}

// C3 — workspace include groups are wired.
const includes = new Set(
    Object.values(groups)
        .filter((entry) => entry.wiring?.kind === 'workspace')
        .map((entry) => entry.wiring?.include)
);
for (const include of ['context', 'shell', 'artifacts']) {
    if (!includes.has(include)) fail({ message: `C3 workspace include "${include}" is not wired by any group` });
}

// C4 — tool names survive the wire.
for (const [groupName, entry] of Object.entries(groups)) {
    if (!Array.isArray(entry.tools) || entry.tools.length === 0) {
        fail({ message: `C4 group "${groupName}" has no tools` });
    }
    for (const tool of entry.tools) {
        if (!/^[a-z][a-z0-9_]*$/.test(tool)) {
            fail({ message: `C4 group "${groupName}" tool "${tool}" is not a plain identifier` });
        }
    }
    if (!Array.isArray(entry.needs)) {
        fail({ message: `C4 group "${groupName}" has no needs array` });
    }
}

// C5 — aliases and meta-groups resolve.
for (const [alias, targets] of Object.entries(aliases ?? {})) {
    if (!Array.isArray(targets) || targets.length === 0) {
        fail({ message: `C5 alias "${alias}" expands to nothing` });
        continue;
    }
    for (const target of targets) {
        if (!groups[target]) fail({ message: `C5 alias "${alias}" points at unknown group "${target}"` });
    }
}
if (!Array.isArray(metaGroups) || metaGroups.length === 0) {
    fail({ message: 'C5 AGENT_META_GROUPS is empty' });
}
for (const meta of metaGroups ?? []) {
    const names = catalog.agentGroupToolNames({ name: meta });
    if (!Array.isArray(names) || names.length === 0) {
        fail({ message: `C5 meta-group "${meta}" resolves to no tools` });
    }
}

if (errors.length > 0) {
    console.error(`agent catalog — ${errors.length} problem(s):`);
    for (const message of errors) console.error(`  - ${message}`);
    process.exit(1);
}

console.log(
    `agent catalog — ok: ${Object.keys(groups).length} groups, `
    + `${Object.keys(aliases ?? {}).length} alias(es), ${catalogToolNames.size} tool name(s) `
    + `(${relative(ROOT, CATALOG_PATH)})`
);
