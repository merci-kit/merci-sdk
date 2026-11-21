// @ts-check
/**
 * @file Scheduler, operator, workspace, memory, web and workflow-runtime limits.
 * @version 0.12.0
 *
 * @description
 * The knobs that bound the long-running machinery: scheduler polling, retry and
 * stall windows, operator HTTP retention, workspace hook/git timeouts, memory
 * distillation and locking, browser and scrape budgets, search/todo retention,
 * and the workflow watcher. Defaults are the SDK's documented behaviour; every
 * one is overridable through `MERCI_LIMIT_<ENV>` or `merci-limits.json`.
 *
 * Concurrency caps declare `unbounded` equal to their default: the switch cannot
 * meaningfully unbound a fan-out, so it holds the documented value instead.
 */

import { NODE_TIMER_MAX, defineLimit } from './define.mjs';

export const RUNTIME_LIMITS = Object.freeze({
    scheduler_poll_interval_ms: defineLimit({
        env: 'SCHEDULER_POLL_INTERVAL_MS', default: 30_000, min: 1, max: 86_400_000, unbounded: 30_000, timer: true,
        doc: 'Pause between scheduler wake-ups when no work is due.'
    }),
    scheduler_stall_timeout_ms: defineLimit({
        env: 'SCHEDULER_STALL_TIMEOUT_MS', default: 900_000, min: 0, max: 86_400_000, unbounded: 900_000, timer: true,
        doc: 'Silence from a running attempt before it is treated as stalled.'
    }),
    scheduler_retry_base_ms: defineLimit({
        env: 'SCHEDULER_RETRY_BASE_MS', default: 10_000, min: 0, max: 86_400_000, unbounded: 10_000, timer: true,
        doc: 'First retry backoff after a failed attempt.'
    }),
    scheduler_retry_max_ms: defineLimit({
        env: 'SCHEDULER_RETRY_MAX_MS', default: 300_000, min: 0, max: 86_400_000, unbounded: 300_000, timer: true,
        doc: 'Ceiling the exponential retry backoff doubles toward.'
    }),
    scheduler_continuation_delay_ms: defineLimit({
        env: 'SCHEDULER_CONTINUATION_DELAY_MS', default: 1_000, min: 0, max: 86_400_000, unbounded: 1_000, timer: true,
        doc: 'Pause before a continuation round is dispatched.'
    }),
    scheduler_continuation_max: defineLimit({
        env: 'SCHEDULER_CONTINUATION_MAX', default: 3, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Continuation rounds one work item may open.'
    }),
    scheduler_max_concurrent: defineLimit({
        env: 'SCHEDULER_MAX_CONCURRENT', default: 1, min: 1, max: 1_000_000, unbounded: 1,
        doc: 'Attempts the scheduler runs at once.'
    }),
    scheduler_max_attempts_per_item: defineLimit({
        env: 'SCHEDULER_MAX_ATTEMPTS_PER_ITEM', default: 5, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Attempts one work item gets before it parks.'
    }),
    scheduler_completed_history_limit: defineLimit({
        env: 'SCHEDULER_COMPLETED_HISTORY_LIMIT', default: 100, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Completed identifiers kept for snapshot().completed.'
    }),
    scheduler_stop_drain_ms: defineLimit({
        env: 'SCHEDULER_STOP_DRAIN_MS', default: 30_000, min: 0, max: 86_400_000, unbounded: 30_000, timer: true,
        doc: 'Default wait for in-flight attempts during stop().'
    }),
    scheduler_park_backoff_cap_ms: defineLimit({
        env: 'SCHEDULER_PARK_BACKOFF_CAP_MS', default: 21_600_000, min: 0, max: 86_400_000, unbounded: 21_600_000, timer: true,
        doc: 'Ceiling on the parked re-check delay.'
    }),
    claim_stale_ms: defineLimit({
        env: 'CLAIM_STALE_MS', default: 21_600_000, min: 0, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Age after which a foreign-host claim is reclaimable.'
    }),
    runner_summary_chars: defineLimit({
        env: 'RUNNER_SUMMARY_CHARS', default: 2_000, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Cap on a step summary string.'
    }),
    runner_step_concurrency: defineLimit({
        env: 'RUNNER_STEP_CONCURRENCY', default: 1, min: 1, max: 1_000_000, unbounded: 1,
        doc: 'Steps one executor run may process at once.'
    }),
    operator_max_body_bytes: defineLimit({
        env: 'OPERATOR_MAX_BODY_BYTES', default: 1_024, min: 1, max: 100_000_000, unbounded: 100_000_000, guard: true,
        doc: 'Request body bytes the operator HTTP handler accepts.'
    }),
    operator_ring_limit: defineLimit({
        env: 'OPERATOR_RING_LIMIT', default: 100, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Events kept in the operator ring buffer.'
    }),
    operator_policy_lines: defineLimit({
        env: 'OPERATOR_POLICY_LINES', default: 10, min: 1, max: 10_000, unbounded: 10_000,
        doc: 'Policy reason and warning lines rendered in one operator status block.'
    }),
    operator_recent_events_limit: defineLimit({
        env: 'OPERATOR_RECENT_EVENTS_LIMIT', default: 20, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Recent events returned by the operator status payload.'
    }),
    operator_status_max_rows: defineLimit({
        env: 'OPERATOR_STATUS_MAX_ROWS', default: 50, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Rows listed per table in the operator status payload.'
    }),
    workspace_hook_timeout_ms: defineLimit({
        env: 'WORKSPACE_HOOK_TIMEOUT_MS', default: 60_000, min: 0, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Default timeout for one workspace hook script.'
    }),
    workspace_git_timeout_ms: defineLimit({
        env: 'WORKSPACE_GIT_TIMEOUT_MS', default: 60_000, min: 0, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Default timeout for one git call.'
    }),
    workspace_git_stderr_tail: defineLimit({
        env: 'WORKSPACE_GIT_STDERR_TAIL', default: 500, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Stderr characters kept on a workspace git error.'
    }),
    orchestration_ring_fallback: defineLimit({
        env: 'ORCHESTRATION_RING_FALLBACK', default: 200, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Ring size the orchestration facade uses when the operator sets none.'
    }),
    memory_sync_interval: defineLimit({
        env: 'MEMORY_SYNC_INTERVAL', default: 5, min: 1, max: 1_000_000, unbounded: 5,
        doc: 'Turns between automatic memory syncs.'
    }),
    memory_distill_fact_history_chars: defineLimit({
        env: 'MEMORY_DISTILL_FACT_HISTORY_CHARS', default: 8_000, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Fact-history chars fed to the distiller.'
    }),
    memory_distill_transcript_chars: defineLimit({
        env: 'MEMORY_DISTILL_TRANSCRIPT_CHARS', default: 32_000, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Transcript chars fed to the distiller.'
    }),
    memory_parse_attempts: defineLimit({
        env: 'MEMORY_PARSE_ATTEMPTS', default: 3, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Parse attempts for a distiller response.'
    }),
    memory_fact_max_chars: defineLimit({
        env: 'MEMORY_FACT_MAX_CHARS', default: 4_000, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Longest stored memory fact content.'
    }),
    memory_lock_timeout_ms: defineLimit({
        env: 'MEMORY_LOCK_TIMEOUT_MS', default: 5_000, min: 0, max: 86_400_000, unbounded: 5_000, timer: true,
        doc: 'How long a writer waits for the bank lock.'
    }),
    memory_lock_stale_ms: defineLimit({
        env: 'MEMORY_LOCK_STALE_MS', default: 5_000, min: 0, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Age at which a pid-less memory lock is reclaimed.'
    }),
    memory_lock_retry_ms: defineLimit({
        env: 'MEMORY_LOCK_RETRY_MS', default: 10, min: 1, max: 86_400_000, unbounded: 10, timer: true,
        doc: 'Pause between memory lock attempts.'
    }),
    memory_query_limit: defineLimit({
        env: 'MEMORY_QUERY_LIMIT', default: 5, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Facts a memory query returns by default.'
    }),
    memory_embed_batch: defineLimit({
        env: 'MEMORY_EMBED_BATCH', default: 16, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Facts embedded per batch call.'
    }),
    memory_busy_timeout_ms: defineLimit({
        env: 'MEMORY_BUSY_TIMEOUT_MS', default: 5_000, min: 0, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'SQLite busy timeout for the local memory store.'
    }),
    memory_max_facts_per_bank: defineLimit({
        env: 'MEMORY_MAX_FACTS_PER_BANK', default: 500, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Facts held per bank, oldest evicted first.'
    }),
    memory_max_history_rows: defineLimit({
        env: 'MEMORY_MAX_HISTORY_ROWS', default: 200, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Rows kept in a memory bank audit trail.'
    }),
    memory_query_min_token_length: defineLimit({
        env: 'MEMORY_QUERY_MIN_TOKEN_LENGTH', default: 3, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Query token length below which a memory lookup is skipped.'
    }),
    browser_max_urls: defineLimit({
        env: 'BROWSER_MAX_URLS', default: 20, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'URLs one browser turn may open.'
    }),
    browser_engine_timeout_ms: defineLimit({
        env: 'BROWSER_ENGINE_TIMEOUT_MS', default: 30_000, min: 0, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Default timeout for one browser engine command.'
    }),
    browser_snapshot_elements: defineLimit({
        env: 'BROWSER_SNAPSHOT_ELEMENTS', default: 100, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Elements listed in one page snapshot.'
    }),
    browser_event_log_cap: defineLimit({
        env: 'BROWSER_EVENT_LOG_CAP', default: 200, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Browser events retained in the log.'
    }),
    browser_content_max_chars: defineLimit({
        env: 'BROWSER_CONTENT_MAX_CHARS', default: 20_000, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Page content chars returned by the browser backend.'
    }),
    browser_wait_timeout_ms: defineLimit({
        env: 'BROWSER_WAIT_TIMEOUT_MS', default: 15_000, min: 0, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Default waitFor budget when the backend sets none.'
    }),
    browser_wait_poll_ms: defineLimit({
        env: 'BROWSER_WAIT_POLL_MS', default: 250, min: 1, max: 86_400_000, unbounded: 250, timer: true,
        doc: 'Pause between waitFor selector checks.'
    }),
    scrape_max_urls: defineLimit({
        env: 'SCRAPE_MAX_URLS', default: 20, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'URLs one scrape call may fetch.'
    }),
    scrape_content_max_chars: defineLimit({
        env: 'SCRAPE_CONTENT_MAX_CHARS', default: 20_000, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Default chars of scraped page text returned to the model.'
    }),
    scrape_max_redirects: defineLimit({
        env: 'SCRAPE_MAX_REDIRECTS', default: 5, min: 0, max: 1_000_000, unbounded: 5,
        doc: 'Redirect hops a guarded scrape fetch follows.'
    }),
    scrape_max_bytes: defineLimit({
        env: 'SCRAPE_MAX_BYTES', default: 5_242_880, guard: true, min: 1_024, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Response bytes a scrape reads before truncating.'
    }),
    scrape_timeout_min_ms: defineLimit({
        env: 'SCRAPE_TIMEOUT_MIN_MS', default: 1_000, min: 0, max: 86_400_000, unbounded: 1_000, timer: true,
        doc: 'Lower clamp on a per-scrape timeout.'
    }),
    scrape_timeout_max_ms: defineLimit({
        env: 'SCRAPE_TIMEOUT_MAX_MS', default: 60_000, min: 1, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Upper clamp on a per-scrape timeout.'
    }),
    search_cache_ttl_ms: defineLimit({
        env: 'SEARCH_CACHE_TTL_MS', default: 300_000, min: 0, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'How long a web-search result stays cached.'
    }),
    search_cache_entries: defineLimit({
        env: 'SEARCH_CACHE_ENTRIES', default: 256, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Web-search results kept in the cache.'
    }),
    todo_preload_max_tasks: defineLimit({
        env: 'TODO_PRELOAD_MAX_TASKS', default: 20, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Tasks preloaded into a todo list.'
    }),
    knowledge_query_max_nodes: defineLimit({
        env: 'KNOWLEDGE_QUERY_MAX_NODES', default: 60, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Nodes a knowledge-graph traversal may return in one subgraph.'
    }),
    knowledge_query_default_depth: defineLimit({
        env: 'KNOWLEDGE_QUERY_DEFAULT_DEPTH', default: 2, min: 0, max: 1_000_000, unbounded: 2,
        doc: 'Traversal depth a knowledge query uses when the caller names none.'
    }),
    knowledge_query_max_depth: defineLimit({
        env: 'KNOWLEDGE_QUERY_MAX_DEPTH', default: 5, min: 0, max: 1_000_000, unbounded: 5,
        doc: 'Hard ceiling on a knowledge-graph traversal depth.'
    }),
    knowledge_query_budget_chars: defineLimit({
        env: 'KNOWLEDGE_QUERY_BUDGET_CHARS', default: 2_400, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Characters a rendered knowledge block may spend in one step.'
    }),
    knowledge_section_map_chars: defineLimit({
        env: 'KNOWLEDGE_SECTION_MAP_CHARS', default: 12_000, min: 0, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Graph size above which the step block renders the section map only.'
    }),
    knowledge_split_chars: defineLimit({
        env: 'KNOWLEDGE_SPLIT_CHARS', default: 90_000, min: 0, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Graph size above which ranked nodes are left to the query tool.'
    }),
    knowledge_wiki_max_section_nodes: defineLimit({
        env: 'KNOWLEDGE_WIKI_MAX_SECTION_NODES', default: 120, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Section nodes drawn into the Mermaid view of a rendered wiki.'
    }),
    knowledge_propose_min_support: defineLimit({
        env: 'KNOWLEDGE_PROPOSE_MIN_SUPPORT', default: 3, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Occurrences a structural signal needs before it proposes a node kind.'
    }),
    knowledge_propose_max_kinds: defineLimit({
        env: 'KNOWLEDGE_PROPOSE_MAX_KINDS', default: 24, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Node kinds a derived profile may carry before the proposal is trimmed to the strongest signals.'
    }),
    knowledge_promote_after: defineLimit({
        env: 'KNOWLEDGE_PROMOTE_AFTER', default: 3, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Distinct notes a custom relation needs before it is reported as promotable.'
    }),
    knowledge_patch_max_nodes: defineLimit({
        env: 'KNOWLEDGE_PATCH_MAX_NODES', default: 200, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Nodes one knowledge patch may add or update.'
    }),
    knowledge_patch_max_edges: defineLimit({
        env: 'KNOWLEDGE_PATCH_MAX_EDGES', default: 400, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Edges one knowledge patch may add.'
    }),
    todo_prune_max_age_ms: defineLimit({
        env: 'TODO_PRUNE_MAX_AGE_MS', default: 604_800_000, min: 0, max: NODE_TIMER_MAX, unbounded: NODE_TIMER_MAX, timer: true,
        doc: 'Age at which a completed todo is pruned (compared, never scheduled).'
    }),
    workflow_debounce_ms: defineLimit({
        env: 'WORKFLOW_DEBOUNCE_MS', default: 100, min: 0, max: 86_400_000, unbounded: 100, timer: true,
        doc: 'Watcher debounce before WORKFLOW.md is reloaded.'
    }),
    workflow_max_file_bytes: defineLimit({
        env: 'WORKFLOW_MAX_FILE_BYTES', default: 1_048_576, min: 1_024, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Largest WORKFLOW.md accepted by the loader.'
    }),
    workflow_max_template_depth: defineLimit({
        env: 'WORKFLOW_MAX_TEMPLATE_DEPTH', default: 32, min: 1, max: 1_000_000, unbounded: 32,
        doc: 'Prompt-template nesting depth the config allows.'
    }),
    workflow_max_rendered_chars: defineLimit({
        env: 'WORKFLOW_MAX_RENDERED_CHARS', default: 1_000_000, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Chars one rendered workflow prompt may reach.'
    }),
    workflow_provider_max_depth: defineLimit({
        env: 'WORKFLOW_PROVIDER_MAX_DEPTH', default: 8, min: 0, max: 1_000_000, unbounded: 8, guard: true,
        doc: 'Tracker provider nesting cap in workflow config.'
    }),
    workflow_alias_max: defineLimit({
        env: 'WORKFLOW_ALIAS_MAX', default: 50, min: 0, max: 1_000_000, unbounded: 1_000_000, guard: true,
        doc: 'YAML alias expansions allowed in WORKFLOW.md.'
    }),
    workflow_template_depth_ceiling: defineLimit({
        env: 'WORKFLOW_TEMPLATE_DEPTH_CEILING', default: 512, min: 1, max: 1_000_000, unbounded: 512, guard: true,
        doc: 'Nesting depth above which rendering risks exhausting the JS stack.'
    }),
    workflow_poll_interval_ms: defineLimit({
        env: 'WORKFLOW_POLL_INTERVAL_MS', default: 30_000, min: 1, max: 86_400_000, unbounded: 30_000, timer: true,
        doc: 'Tracker polling interval for the workflow runner.'
    }),
    workflow_hook_timeout_ms: defineLimit({
        env: 'WORKFLOW_HOOK_TIMEOUT_MS', default: 60_000, min: 0, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Timeout for one workflow hook script.'
    }),
    workflow_max_concurrent_agents: defineLimit({
        env: 'WORKFLOW_MAX_CONCURRENT_AGENTS', default: 1, min: 1, max: 1_000_000, unbounded: 1,
        doc: 'Agents the workflow runner dispatches at once.'
    }),
    workflow_agent_max_turns: defineLimit({
        env: 'WORKFLOW_AGENT_MAX_TURNS', default: 20, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Turns one workflow agent run may take.'
    }),
    workflow_retry_max_backoff_ms: defineLimit({
        env: 'WORKFLOW_RETRY_MAX_BACKOFF_MS', default: 300_000, min: 0, max: 86_400_000, unbounded: 300_000, timer: true,
        doc: 'Ceiling on workflow agent retry backoff.'
    }),
    workflow_max_attempts_per_item: defineLimit({
        env: 'WORKFLOW_MAX_ATTEMPTS_PER_ITEM', default: 5, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Attempts one workflow item gets before it parks.'
    }),
    workflow_continuation_max: defineLimit({
        env: 'WORKFLOW_CONTINUATION_MAX', default: 3, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Continuation rounds one workflow item may open.'
    }),
    workflow_continuation_delay_ms: defineLimit({
        env: 'WORKFLOW_CONTINUATION_DELAY_MS', default: 1_000, min: 0, max: 86_400_000, unbounded: 1_000, timer: true,
        doc: 'Pause before a workflow continuation is dispatched.'
    }),
    workflow_stall_timeout_ms: defineLimit({
        env: 'WORKFLOW_STALL_TIMEOUT_MS', default: 900_000, min: 0, max: 86_400_000, unbounded: 900_000, timer: true,
        doc: 'Silence from a workflow attempt before it is treated as stalled.'
    }),
    workflow_retry_base_ms: defineLimit({
        env: 'WORKFLOW_RETRY_BASE_MS', default: 10_000, min: 0, max: 86_400_000, unbounded: 10_000, timer: true,
        doc: 'First workflow retry backoff after a failed attempt.'
    })
});
