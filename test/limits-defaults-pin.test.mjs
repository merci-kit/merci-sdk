// @ts-check
/**
 * @file Pins the shipped default of every reviewed limit to a literal, so a
 * typo in `lib/core/constants/limits/**` cannot ship silently and a renamed
 * key fails loudly instead of dropping a row. Also pins the `DEFAULT_*` code
 * defaults the barrel freezes at import, and proves every
 * `LIMIT_DEFAULT_ALLOWLIST` sanction still names a real export that reads its
 * key.
 * @version 0.12.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    LIMIT_REGISTRY,
    DEFAULT_MAX_ITERATIONS,
    DEFAULT_MAX_SCHEMA_RETRIES,
    DEFAULT_MAX_FOLLOW_UPS,
    DEFAULT_STREAM_TIMEOUT_MS,
    DEFAULT_COMPACTION_THRESHOLD_TOKENS,
    DEFAULT_DAG_HITL_TIMEOUT_MS,
    DEFAULT_MAX_REPLAN_COUNT,
    DEFAULT_DAG_MAX_DEPTH,
    DEFAULT_MAX_VISITS_PER_NODE,
    DEFAULT_MAX_MACHINE_STEPS,
    DEFAULT_RETRY_LIMIT
} from '../lib/core/constants/limits.mjs';
import { LIMIT_DEFAULT_ALLOWLIST } from '../scripts/check-limits.mjs';

/**
 * Key and the exact default that has been reviewed. Tests may read
 * `.default`; the L7 gate covers `lib/` only.
 * @type {ReadonlyArray<readonly [string, number]>}
 */
const PINNED_DEFAULTS = [
    // Tools and transport.
    ['tool_output_max_chars', 50_000],
    ['mcp_task_page_size', 100],
    ['mcp_output_max_chars', 50_000],
    ['mcp_default_timeout_ms', 60_000],
    ['mcp_probe_timeout_ms', 10_000],
    ['a2a_request_max_body_bytes', 10_000_000],
    ['a2a_timeout_ms', 30_000],
    ['mcp_reconnect_base_delay_ms', 250],
    ['tool_search_max_results', 20],
    ['read_max_bytes', 51_200],
    ['read_binary_ratio', 0.3],
    ['run_command_max_buffer_bytes', 10_485_760],
    ['sse_max_line_bytes', 1_048_576],
    ['jai_header_timeout_ms', 600_000],
    ['safe_stringify_max_nodes', 20_000],
    // Memory.
    ['memory_max_history_rows', 200],
    ['memory_sync_interval', 5],
    ['memory_query_min_token_length', 3],
    ['memory_max_facts_per_bank', 500],
    // Models.
    ['anthropic_max_tokens', 8_192],
    ['default_embedding_dimensions', 1_024],
    // Knowledge.
    ['knowledge_query_budget_chars', 2_400],
    ['knowledge_section_map_chars', 12_000],
    ['knowledge_split_chars', 90_000],
    ['knowledge_wiki_max_section_nodes', 120],
    ['knowledge_patch_max_nodes', 200],
    ['knowledge_patch_max_edges', 400],
    ['knowledge_propose_min_support', 3],
    ['knowledge_propose_max_kinds', 24],
    ['knowledge_promote_after', 3],
    ['knowledge_query_default_depth', 2],
    ['knowledge_query_max_nodes', 60],
    // Agentic loop, objective, and transfer (limits/agent.mjs).
    ['journal_max_attempts', 100],
    ['objective_max_chars', 4_000],
    ['transfer_tail_rows', 8],
    ['compaction_keep_recent', 4],
    ['default_delegation_depth', 1],
    ['max_parallel_tools', 0],
    // Planning (limits/planning.mjs).
    ['max_replan_count', 3],
    // Runtime caps for sources that fan out over URLs (limits/runtime.mjs).
    ['scrape_max_urls', 20],
    ['browser_max_urls', 20],
    ['scheduler_max_concurrent', 1],
    ['operator_max_body_bytes', 1_024]
];

/**
 * The 11 `DEFAULT_*` constants the barrel freezes at import, each with its
 * reviewed literal. Listed explicitly, not reflected over the module: a
 * renamed export must fail here instead of silently dropping a row.
 * @type {ReadonlyArray<readonly [string, number]>}
 */
const PINNED_CODE_DEFAULTS = [
    ['DEFAULT_MAX_ITERATIONS', 5],
    ['DEFAULT_MAX_SCHEMA_RETRIES', 2],
    ['DEFAULT_MAX_FOLLOW_UPS', 4],
    ['DEFAULT_STREAM_TIMEOUT_MS', 150_000],
    ['DEFAULT_COMPACTION_THRESHOLD_TOKENS', 6_000],
    ['DEFAULT_DAG_HITL_TIMEOUT_MS', 300_000],
    ['DEFAULT_MAX_REPLAN_COUNT', 3],
    ['DEFAULT_DAG_MAX_DEPTH', 1],
    ['DEFAULT_MAX_VISITS_PER_NODE', 10],
    ['DEFAULT_MAX_MACHINE_STEPS', 100],
    ['DEFAULT_RETRY_LIMIT', 2]
];

/** @type {Record<string, number>} */
const CODE_DEFAULT = {
    DEFAULT_MAX_ITERATIONS,
    DEFAULT_MAX_SCHEMA_RETRIES,
    DEFAULT_MAX_FOLLOW_UPS,
    DEFAULT_STREAM_TIMEOUT_MS,
    DEFAULT_COMPACTION_THRESHOLD_TOKENS,
    DEFAULT_DAG_HITL_TIMEOUT_MS,
    DEFAULT_MAX_REPLAN_COUNT,
    DEFAULT_DAG_MAX_DEPTH,
    DEFAULT_MAX_VISITS_PER_NODE,
    DEFAULT_MAX_MACHINE_STEPS,
    DEFAULT_RETRY_LIMIT
};

test('every reviewed registry default still equals its pinned literal', () => {
    for (const [key, literal] of PINNED_DEFAULTS) {
        const entry = LIMIT_REGISTRY[key];
        assert.ok(entry, `${key}: pinned key is missing from LIMIT_REGISTRY (renamed or removed)`);
        assert.equal(entry.default, literal, `${key}: registry default ${entry.default}, pinned ${literal}`);
    }
});

test('every barrel code default still equals its pinned literal', () => {
    for (const [name, literal] of PINNED_CODE_DEFAULTS) {
        assert.equal(CODE_DEFAULT[name], literal, `${name} drifted from its frozen literal ${literal}`);
    }
});

test('every allowlist sanction is still a top-level export reading its key', () => {
    for (const { file, key, name } of LIMIT_DEFAULT_ALLOWLIST) {
        const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
        const declaration = new RegExp(
            `^export const ${name}\\s*=\\s*(?:LIMIT_REGISTRY\\.${key}\\.default|LIMIT_DEFAULTS\\.${key});`,
            'm'
        );
        assert.match(source, declaration,
            `${file} must still declare \`export const ${name}\` from ${key}; a stale sanction hides the read`);
    }
});
