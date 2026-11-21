// @ts-check
/**
 * @file Agent-loop, compaction, objective, delegation and journal limits.
 * @version 0.12.0
 *
 * @description
 * The knobs that bound one agent run: tool-loop turns, follow-up rounds,
 * context compaction, objective restatement cadence, subagent fan-out and
 * discussion/journal retention. Defaults are the SDK's documented behaviour;
 * every one is overridable through `MERCI_LIMIT_<ENV>` or `merci-limits.json`.
 *
 * Concurrency and spawn-depth caps declare `unbounded` equal to their default:
 * the switch cannot meaningfully unbound a fan-out, so it holds the documented
 * value instead.
 */

import { defineLimit } from './define.mjs';

export const AGENT_LIMITS = Object.freeze({
    max_iterations: defineLimit({
        env: 'MAX_ITERATIONS', default: 5, min: 1, max: 10_000, unbounded: 10_000,
        doc: 'Tool-loop turns per run()/step() before forcing a final text answer.'
    }),
    max_inbox_turns: defineLimit({
        env: 'MAX_INBOX_TURNS', default: 8, min: 0, max: 1_000, unbounded: 1_000,
        doc: 'Inbox-driven continuation turns per run(): a message enqueued mid-run gets its own turn, up to this many before it waits for the next run.'
    }),
    inbox_lease_stale_ms: defineLimit({
        env: 'INBOX_LEASE_STALE_MS', default: 30_000, min: 1_000, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Age after which a durable inbox lease left by a stopped process may be reclaimed by another drainer.'
    }),
    inbox_lease_renew_ms: defineLimit({
        env: 'INBOX_LEASE_RENEW_MS', default: 10_000, min: 100, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Heartbeat interval at which a running inbox drain renews its lease.'
    }),
    inbox_background_recheck_ms: defineLimit({
        env: 'INBOX_BACKGROUND_RECHECK_MS', default: 5_000, min: 100, max: 600_000, unbounded: 600_000, timer: true,
        doc: 'Interval at which a waiting inbox drain re-checks whether a background subagent is still running.'
    }),
    inbox_background_wait_ms: defineLimit({
        env: 'INBOX_BACKGROUND_WAIT_MS', default: 30_000, min: 0, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'How long drainInbox() waits for live background subagents to settle before it leaves the queue for the next call (0 = do not wait).'
    }),
    max_follow_ups: defineLimit({
        env: 'MAX_FOLLOW_UPS', default: 4, min: 0, max: 1_000, unbounded: 1_000,
        doc: 'Safety cap on staged follow-up rounds (opts.followUp).'
    }),
    max_schema_retries: defineLimit({
        env: 'MAX_SCHEMA_RETRIES', default: 2, min: 0, max: 1_000, unbounded: 1_000,
        doc: 'Corrective retries for a schema-invalid structured deliverable.'
    }),
    max_consecutive_empty: defineLimit({
        env: 'MAX_CONSECUTIVE_EMPTY', default: 2, min: 1, max: 1_000, unbounded: 1_000,
        doc: 'Consecutive empty model responses tolerated before giving up.'
    }),
    max_follow_up_extensions: defineLimit({
        env: 'MAX_FOLLOW_UP_EXTENSIONS', default: 3, min: 0, max: 1_000, unbounded: 1_000,
        doc: 'Max times a followUp stage may extend itself.'
    }),
    auto_extend_min_novel_tool_calls: defineLimit({
        env: 'AUTO_EXTEND_MIN_NOVEL_TOOL_CALLS', default: 1, min: 1, max: 1_000, unbounded: 1_000,
        doc: 'Novel tool calls required before the loop auto-extends past the turn cap.'
    }),
    synthesis_retry_backoff_ms: defineLimit({
        env: 'SYNTHESIS_RETRY_BACKOFF_MS', default: 500, min: 0, max: 60_000, unbounded: 500,
        doc: 'Backoff (ms) before re-running a synthesis after a recovery attempt.'
    }),
    compaction_threshold_tokens: defineLimit({
        env: 'COMPACTION_THRESHOLD_TOKENS', default: 6_000, min: 100, max: 10_000_000, unbounded: 10_000_000,
        doc: 'Estimated token count at which history compaction kicks in.'
    }),
    compaction_keep_recent: defineLimit({
        env: 'COMPACTION_KEEP_RECENT', default: 4, min: 0, max: 10_000, unbounded: 10_000,
        doc: 'History rows kept un-folded when compaction runs.'
    }),
    compaction_clear_tool_keep_recent: defineLimit({
        env: 'COMPACTION_CLEAR_TOOL_KEEP_RECENT', default: 3, min: 0, max: 10_000, unbounded: 10_000,
        doc: 'Tool-result rows kept by the cheap clear pass before summary compaction.'
    }),
    compaction_summarizer_attempts: defineLimit({
        env: 'COMPACTION_SUMMARIZER_ATTEMPTS', default: 1, min: 1, max: 100, unbounded: 100,
        doc: 'LLM attempts for the compaction summarizer before falling back to a loss marker.'
    }),
    objective_update_turns: defineLimit({
        env: 'OBJECTIVE_UPDATE_TURNS', default: 10, min: 0, max: 10_000, unbounded: 10_000,
        doc: 'Turn cadence for restating the objective.'
    }),
    objective_first_update: defineLimit({
        env: 'OBJECTIVE_FIRST_UPDATE', default: 1, min: 0, max: 10_000, unbounded: 10_000,
        doc: 'Turn of the first objective restatement.'
    }),
    objective_max_chars: defineLimit({
        env: 'OBJECTIVE_MAX_CHARS', default: 4_000, min: 100, max: 10_000_000, unbounded: 10_000_000,
        doc: 'Longest accepted objective restatement.'
    }),
    objective_intake_rows: defineLimit({
        env: 'OBJECTIVE_INTAKE_ROWS', default: 6, min: 0, max: 1_000, unbounded: 1_000,
        doc: 'User rows fed to the objective restatement prompt.'
    }),
    objective_digest_chars: defineLimit({
        env: 'OBJECTIVE_DIGEST_CHARS', default: 6_000, min: 100, max: 10_000_000, unbounded: 10_000_000,
        doc: 'Char cap on the progress digest appended to the objective prompt.'
    }),
    objective_restate_iterations: defineLimit({
        env: 'OBJECTIVE_RESTATE_ITERATIONS', default: 1, min: 1, max: 100, unbounded: 100,
        doc: 'Turns allowed for one objective restatement session.'
    }),
    instruction_file_max_bytes: defineLimit({
        env: 'INSTRUCTION_FILE_MAX_BYTES', default: 262_144, min: 1_024, max: 1_000_000_000, unbounded: 1_000_000_000,
        doc: 'Largest instruction file (AGENTS.md) read into the environment block.'
    }),
    instruction_cache_max: defineLimit({
        env: 'INSTRUCTION_CACHE_MAX', default: 64, min: 1, max: 100_000, unbounded: 100_000,
        doc: 'Entries kept in the discovered-instruction cache.'
    }),
    agent_script_max_bytes: defineLimit({
        env: 'AGENT_SCRIPT_MAX_BYTES', default: 1_048_576, min: 1, max: 1_000_000_000, unbounded: 1_000_000_000,
        doc: 'Largest script file an agent tool may point at.'
    }),
    agent_script_timeout_ms: defineLimit({
        env: 'AGENT_SCRIPT_TIMEOUT_MS', default: 30_000, min: 1, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Timeout (ms) for one agent script tool run before it is aborted.'
    }),
    agent_script_output_chars: defineLimit({
        env: 'AGENT_SCRIPT_OUTPUT_CHARS', default: 100_000, min: 100, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Character cap on text returned by an agent script tool.'
    }),
    agent_max_script_tools: defineLimit({
        env: 'AGENT_MAX_SCRIPT_TOOLS', default: 32, min: 1, max: 10_000, unbounded: 32,
        doc: 'Script tools one agent definition may declare.'
    }),
    agent_max_iterations: defineLimit({
        env: 'AGENT_MAX_ITERATIONS', default: 1_000, min: 1, max: 100_000, unbounded: 1_000,
        doc: 'Ceiling an agent file may declare for maxIterations.'
    }),
    agent_max_depth: defineLimit({
        env: 'AGENT_MAX_DEPTH', default: 16, min: 1, max: 64, unbounded: 16,
        doc: 'Ceiling an agent file may declare for maxDepth.'
    }),
    agent_timeout_ms: defineLimit({
        env: 'AGENT_TIMEOUT_MS', default: 86_400_000, min: 1, max: 2_592_000_000, unbounded: 86_400_000, timer: true,
        doc: 'Ceiling an agent file may declare for one-turn timeoutMs.'
    }),
    agent_max_elapsed_ms: defineLimit({
        env: 'AGENT_MAX_ELAPSED_MS', default: 604_800_000, min: 1, max: 2_592_000_000, unbounded: 604_800_000, timer: true,
        doc: 'Ceiling an agent file may declare for maxElapsedMs.'
    }),
    agent_file_max_bytes: defineLimit({
        env: 'AGENT_FILE_MAX_BYTES', default: 1_048_576, min: 1_024, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Largest *.agent.yaml file accepted by the loader.'
    }),
    agent_file_alias_max: defineLimit({
        env: 'AGENT_FILE_ALIAS_MAX', default: 50, min: 0, max: 1_000_000, unbounded: 1_000_000, guard: true,
        doc: 'YAML alias expansions allowed in an agent definition.'
    }),
    agent_file_max_count: defineLimit({
        env: 'AGENT_FILE_MAX_COUNT', default: 256, min: 1, max: 100_000, unbounded: 256,
        doc: 'Agent definition files one directory load may read.'
    }),
    agent_name_max: defineLimit({
        env: 'AGENT_NAME_MAX', default: 64, min: 1, max: 1_000, unbounded: 64,
        doc: 'Longest metadata.name accepted in an agent definition.'
    }),
    agent_description_max_chars: defineLimit({
        env: 'AGENT_DESCRIPTION_MAX_CHARS', default: 500, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Longest metadata.description accepted in an agent definition.'
    }),
    agent_instructions_max_chars: defineLimit({
        env: 'AGENT_INSTRUCTIONS_MAX_CHARS', default: 200_000, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Longest spec.instructions text accepted in an agent definition.'
    }),
    agent_max_selectors: defineLimit({
        env: 'AGENT_MAX_SELECTORS', default: 128, min: 1, max: 1_000_000, unbounded: 128,
        doc: 'Selectors one agent allow or deny list may carry.'
    }),
    agent_tool_name_max: defineLimit({
        env: 'AGENT_TOOL_NAME_MAX', default: 64, min: 1, max: 1_000, unbounded: 64,
        doc: 'Longest script tool name accepted in an agent definition.'
    }),
    agent_max_env_keys: defineLimit({
        env: 'AGENT_MAX_ENV_KEYS', default: 32, min: 0, max: 10_000, unbounded: 32,
        doc: 'Parent environment keys one agent script tool may forward.'
    }),
    max_context_chain_depth: defineLimit({
        env: 'MAX_CONTEXT_CHAIN_DEPTH', default: 32, min: 1, max: 10_000, unbounded: 32,
        doc: 'Depth walked when a context processor chains to another.'
    }),
    parent_history_rows: defineLimit({
        env: 'PARENT_HISTORY_ROWS', default: 8, min: 0, max: 10_000, unbounded: 10_000,
        doc: 'Parent rows kept in a moderated subagent hand-off digest.'
    }),
    parent_history_row_cap: defineLimit({
        env: 'PARENT_HISTORY_ROW_CAP', default: 400, min: 16, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Chars kept per row in a compacted parent digest.'
    }),
    parent_fork_rows: defineLimit({
        env: 'PARENT_FORK_ROWS', default: 40, min: 0, max: 10_000, unbounded: 10_000,
        doc: 'Tail window of parent history a forked subagent receives.'
    }),
    max_parallel_tools: defineLimit({
        env: 'MAX_PARALLEL_TOOLS', default: 0, min: 0, max: 1_000, unbounded: 0,
        doc: 'Parallel tool-call cap per round (0 = unbounded).'
    }),
    max_spawns: defineLimit({
        env: 'MAX_SPAWNS', default: 128, min: 1, max: 1_000_000, unbounded: 128,
        doc: 'Subagent spawns one spawn tree may open.'
    }),
    default_delegation_depth: defineLimit({
        env: 'DEFAULT_DELEGATION_DEPTH', default: 1, min: 0, max: 100, unbounded: 1,
        doc: 'Default subagent nesting depth when the host does not declare one.'
    }),
    spawn_retention: defineLimit({
        env: 'SPAWN_RETENTION', default: 100, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Settled spawns retained for listSpawns() and continuation.'
    }),
    discussion_ledger_max: defineLimit({
        env: 'DISCUSSION_LEDGER_MAX', default: 1_000, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Default discussion-ledger retention.'
    }),
    discussion_ledger_seed_max: defineLimit({
        env: 'DISCUSSION_LEDGER_SEED_MAX', default: 1_000, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Rows accepted when restoring a ledger through appendLedger().'
    }),
    discussion_summary_cache_max: defineLimit({
        env: 'DISCUSSION_SUMMARY_CACHE_MAX', default: 3, min: 1, max: 10_000, unbounded: 10_000,
        doc: 'Cached ledger summaries kept per discussion session.'
    }),
    discussion_summary_input_chars: defineLimit({
        env: 'DISCUSSION_SUMMARY_INPUT_CHARS', default: 32_000, min: 100, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Chars fed to the ledger summarizer.'
    }),
    discussion_summary_chars: defineLimit({
        env: 'DISCUSSION_SUMMARY_CHARS', default: 8_000, min: 100, max: 10_000_000, unbounded: 10_000_000,
        doc: 'Char cap on a single ledger summary.'
    }),
    discussion_turns: defineLimit({
        env: 'DISCUSSION_TURNS', default: 1, min: 1, max: 100, unbounded: 100,
        doc: 'Default discussion rounds per discuss() call.'
    }),
    discuss_max_rounds: defineLimit({
        env: 'DISCUSS_MAX_ROUNDS', default: 2, min: 1, max: 100, unbounded: 100,
        doc: 'Default judge/revision rounds for conclude().'
    }),
    transfer_tail_rows: defineLimit({
        env: 'TRANSFER_TAIL_ROWS', default: 8, min: 0, max: 10_000, unbounded: 10_000,
        doc: 'Rows kept in a tail transfer between stages.'
    }),
    journal_max_attempts: defineLimit({
        env: 'JOURNAL_MAX_ATTEMPTS', default: 100, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Attempts recorded per journal key before the run must use a new key.'
    }),
    prompt_cache_points: defineLimit({
        env: 'PROMPT_CACHE_POINTS', default: 1, min: 0, max: 4, unbounded: 4,
        doc: 'Anthropic prompt-cache breakpoints requested per request (provider maximum 4).'
    }),
    evals_concurrency: defineLimit({
        env: 'EVALS_CONCURRENCY', default: 1, min: 1, max: 1_000, unbounded: 1,
        doc: 'Concurrent eval cases run by runEvals() when no option is passed.'
    }),
    prompt_cache_points_max: defineLimit({
        env: 'PROMPT_CACHE_POINTS_MAX', default: 4, min: 1, max: 4, unbounded: 4, mutable: false,
        doc: 'Fixed provider ceiling (Anthropic accepts at most four cache breakpoints); not configurable.'
    }),
    relay_max_listeners: defineLimit({
        env: 'RELAY_MAX_LISTENERS', default: 30, min: 1, max: 10_000, unbounded: 10_000,
        doc: 'Max listeners attached to an internal relay emitter.'
    }),
    decision_gate_threshold: defineLimit({
        env: 'DECISION_GATE_THRESHOLD', default: 0.85, min: 0.5, max: 1, unbounded: 0.85, integer: false,
        doc: 'Certainty below which a decision gate escalates to the LLM path.'
    }),
    decision_state_max_chars: defineLimit({
        env: 'DECISION_STATE_MAX_CHARS', default: 8000, min: 256, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Characters of decision state kept before a System One call.'
    }),
    decision_skip_certainty: defineLimit({
        env: 'DECISION_SKIP_CERTAINTY', default: 0.9, min: 0.5, max: 1, unbounded: 0.9, integer: false,
        doc: 'Certainty required before a decision gate may SKIP an LLM verifier; stricter than the escalation threshold.'
    }),
    step_min_output_tokens: defineLimit({
        env: 'STEP_MIN_OUTPUT_TOKENS', default: 16, min: 1, max: 4_096, unbounded: 16,
        doc: 'Below this output allowance a capped turn is reported as budget-starved (B-3), so a one-token answer is never mistaken for a real one.'
    }),
    budget_admission_wait_ms: defineLimit({
        env: 'BUDGET_ADMISSION_WAIT_MS', default: 0, min: 0, max: 60_000, unbounded: 0,
        doc: "Optional cap (ms) on how long a capped turn may wait for a sibling's shared-pool reservation to free a usable output allowance. 0 waits for the holder until capacity arrives or the run aborts; a reservation held by the turn's own ancestor is never waited for."
    })
});
