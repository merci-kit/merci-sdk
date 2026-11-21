// @ts-check
/**
 * @file Shell, read/grep, skill, MCP and A2A tool limits.
 * @version 0.12.0
 *
 * @description
 * The knobs that bound one tool call: shell timeouts and output caps, the
 * read/grep context tools, skill catalogs and scripts, and the MCP/A2A
 * protocol clients and task stores. Defaults are the SDK's documented
 * behaviour; every one is overridable through `MERCI_LIMIT_<ENV>` or
 * `merci-limits.json`.
 */

import { defineLimit } from './define.mjs';

export const TOOLS_LIMITS = Object.freeze({
    shell_tool_timeout_ms: defineLimit({
        env: 'SHELL_TOOL_TIMEOUT_MS', default: 10_000, min: 1, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Timeout (ms) for one shell tool command before it is aborted.'
    }),
    shell_tool_max_output_chars: defineLimit({
        env: 'SHELL_TOOL_MAX_OUTPUT_CHARS', default: 4_000, min: 100, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Characters of shell tool output kept before truncation.'
    }),
    shell_tool_max_pipeline_stages: defineLimit({
        env: 'SHELL_TOOL_MAX_PIPELINE_STAGES', default: 5, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Stages one structured shell pipeline may chain.'
    }),
    tool_timeout_ms: defineLimit({
        env: 'TOOL_TIMEOUT_MS', default: 0, min: 0, max: 86_400_000, unbounded: 0, timer: true,
        doc: 'Per-tool execution timeout (0 = none) when the host sets no option.'
    }),
    tool_search_max_results: defineLimit({
        env: 'TOOL_SEARCH_MAX_RESULTS', default: 20, min: 1, max: 10_000, unbounded: 10_000,
        doc: 'Deferred-tool matches returned and activated by one tool_search call.'
    }),
    shell_tool_buffer_multiplier: defineLimit({
        env: 'SHELL_TOOL_BUFFER_MULTIPLIER', default: 4, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Multiple of the output cap reserved as the child process maxBuffer.'
    }),
    tool_output_max_chars: defineLimit({
        env: 'TOOL_OUTPUT_MAX_CHARS', default: 50_000, min: 100, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Character cap on a single remote tool result\'s text.'
    }),
    capped_object_keys: defineLimit({
        env: 'CAPPED_OBJECT_KEYS', default: 1_000, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Object keys the structured output cap keeps before dropping the rest.'
    }),
    elided_key_chars: defineLimit({
        env: 'ELIDED_KEY_CHARS', default: 64, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Characters of a key kept when the output budget is spent.'
    }),
    cap_max_depth: defineLimit({
        env: 'CAP_MAX_DEPTH', default: 8, min: 1, max: 1_000_000, unbounded: 8, guard: true,
        doc: 'Depth the structured output cap walks before eliding a subtree.'
    }),
    skill_catalog_chars: defineLimit({
        env: 'SKILL_CATALOG_CHARS', default: 4_000, min: 100, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Character budget of the skill listing injected into the prompt.'
    }),
    skill_script_timeout_ms: defineLimit({
        env: 'SKILL_SCRIPT_TIMEOUT_MS', default: 10_000, min: 1, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Timeout (ms) for one skill script run before it is aborted.'
    }),
    skill_output_chars: defineLimit({
        env: 'SKILL_OUTPUT_CHARS', default: 50_000, min: 100, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Character cap on text returned by a skill tool.'
    }),
    read_default_limit: defineLimit({
        env: 'READ_DEFAULT_LIMIT', default: 2_000, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Lines the read tool returns when the caller passes no limit.'
    }),
    read_max_line_chars: defineLimit({
        env: 'READ_MAX_LINE_CHARS', default: 2_000, min: 100, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Characters kept per line the read tool returns.'
    }),
    read_max_bytes: defineLimit({
        env: 'READ_MAX_BYTES', default: 51_200, min: 1_024, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Byte budget of one read-tool response.'
    }),
    read_sample_bytes: defineLimit({
        env: 'READ_SAMPLE_BYTES', default: 4_096, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Leading bytes sampled to decide whether a file is binary.'
    }),
    read_max_file_bytes: defineLimit({
        env: 'READ_MAX_FILE_BYTES', default: 8_388_608, min: 1_024, max: 100_000_000, unbounded: 100_000_000, guard: true,
        doc: 'Largest file the read tool opens at all.'
    }),
    read_binary_ratio: defineLimit({
        env: 'READ_BINARY_RATIO', default: 0.3, min: 0, max: 1, unbounded: 1, integer: false,
        doc: 'Share of non-printable bytes that marks a file sample binary.'
    }),
    grep_result_limit: defineLimit({
        env: 'GREP_RESULT_LIMIT', default: 100, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Result rows the grep tool returns before truncating.'
    }),
    grep_max_count_per_file: defineLimit({
        env: 'GREP_MAX_COUNT_PER_FILE', default: 100, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Matches ripgrep reports per file in one grep call.'
    }),
    grep_command_timeout_ms: defineLimit({
        env: 'GREP_COMMAND_TIMEOUT_MS', default: 10_000, min: 1, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Timeout (ms) for one ripgrep process.'
    }),
    grep_missing_probe_ms: defineLimit({
        env: 'GREP_MISSING_PROBE_MS', default: 5_000, min: 1, max: 86_400_000, unbounded: 5_000, timer: true,
        doc: 'Delay (ms) before a missing-ripgrep check is retried.'
    }),
    did_you_mean_candidates: defineLimit({
        env: 'DID_YOU_MEAN_CANDIDATES', default: 3, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Directory entries offered as did-you-mean names on a read miss.'
    }),
    mcp_output_max_chars: defineLimit({
        env: 'MCP_OUTPUT_MAX_CHARS', default: 50_000, min: 100, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Character cap on a single MCP tool result\'s text.'
    }),
    mcp_default_timeout_ms: defineLimit({
        env: 'MCP_DEFAULT_TIMEOUT_MS', default: 60_000, min: 1, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Default request timeout (ms) for an MCP server call.'
    }),
    mcp_probe_timeout_ms: defineLimit({
        env: 'MCP_PROBE_TIMEOUT_MS', default: 10_000, min: 1, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Upper bound (ms) on the server/discover probe a modern connect sends.'
    }),
    mcp_reconnect_attempts: defineLimit({
        env: 'MCP_RECONNECT_ATTEMPTS', default: 0, min: 0, max: 1_000_000, unbounded: 0,
        doc: 'Reconnect attempts after a failed MCP start (0 disables).'
    }),
    mcp_reconnect_base_delay_ms: defineLimit({
        env: 'MCP_RECONNECT_BASE_DELAY_MS', default: 250, min: 1, max: 86_400_000, unbounded: 250, timer: true,
        doc: 'Backoff base (ms) between MCP reconnect attempts.'
    }),
    mcp_task_wait_ms: defineLimit({
        env: 'MCP_TASK_WAIT_MS', default: 300_000, min: 1, max: 86_400_000, unbounded: 300_000, timer: true,
        doc: 'Longest (ms) waitForTask polls before throwing.'
    }),
    mcp_task_poll_ms: defineLimit({
        env: 'MCP_TASK_POLL_MS', default: 1_000, min: 1, max: 86_400_000, unbounded: 1_000, timer: true,
        doc: 'Poll interval (ms) used when a task reports none.'
    }),
    mcp_task_page_size: defineLimit({
        env: 'MCP_TASK_PAGE_SIZE', default: 100, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Tasks returned by one tasks/list page.'
    }),
    mcp_task_ttl_ms: defineLimit({
        env: 'MCP_TASK_TTL_MS', default: 300_000, min: 1, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Retention (ms) of a settled MCP task in the store.'
    }),
    mcp_http_sessions_max: defineLimit({
        env: 'MCP_HTTP_SESSIONS_MAX', default: 256, min: 1, max: 1_000_000, unbounded: 1_000_000, guard: true,
        doc: 'Live Streamable-HTTP MCP sessions kept; at the cap the oldest idle session is closed.'
    }),
    mcp_http_session_idle_ms: defineLimit({
        env: 'MCP_HTTP_SESSION_IDLE_MS', default: 300_000, min: 1, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Idle (ms) after which the sweep closes an MCP HTTP session.'
    }),
    a2a_output_max_chars: defineLimit({
        env: 'A2A_OUTPUT_MAX_CHARS', default: 50_000, min: 100, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Character cap on text returned by an A2A delegation.'
    }),
    a2a_max_body_bytes: defineLimit({
        env: 'A2A_MAX_BODY_BYTES', default: 10_000_000, min: 1_024, max: 100_000_000, unbounded: 100_000_000, guard: true,
        doc: 'Largest A2A response body accepted from a peer.'
    }),
    a2a_timeout_ms: defineLimit({
        env: 'A2A_TIMEOUT_MS', default: 30_000, min: 1, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Default A2A delegation timeout (ms).'
    }),
    a2a_cancel_budget_ms: defineLimit({
        env: 'A2A_CANCEL_BUDGET_MS', default: 5_000, min: 1, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Budget (ms) for the best-effort cancel sent to a peer after a deadline.'
    }),
    a2a_poll_max_ms: defineLimit({
        env: 'A2A_POLL_MAX_MS', default: 250, min: 1, max: 86_400_000, unbounded: 250, timer: true,
        doc: 'Longest (ms) sleep between A2A task polls.'
    }),
    a2a_poll_min_ms: defineLimit({
        env: 'A2A_POLL_MIN_MS', default: 50, min: 1, max: 86_400_000, unbounded: 50, timer: true,
        doc: 'Shortest (ms) sleep between A2A task polls.'
    }),
    a2a_request_max_body_bytes: defineLimit({
        env: 'A2A_REQUEST_MAX_BODY_BYTES', default: 10_000_000, min: 1_024, max: 100_000_000, unbounded: 100_000_000, guard: true,
        doc: 'Largest A2A request body accepted by the server.'
    }),
    a2a_page_size: defineLimit({
        env: 'A2A_PAGE_SIZE', default: 50, min: 1, max: 10_000, unbounded: 10_000,
        doc: 'Default tasks/list page size on the A2A server.'
    }),
    a2a_page_size_max: defineLimit({
        env: 'A2A_PAGE_SIZE_MAX', default: 100, min: 1, max: 10_000, unbounded: 10_000,
        doc: 'Largest tasks/list page a client may request from the A2A server.'
    }),
    a2a_terminal_tasks_max: defineLimit({
        env: 'A2A_TERMINAL_TASKS_MAX', default: 1_000, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Terminal A2A tasks retained before the oldest are evicted.'
    }),
    a2a_task_retention_ms: defineLimit({
        env: 'A2A_TASK_RETENTION_MS', default: 3_600_000, min: 1, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Retention (ms) of a terminal A2A task.'
    }),
    shell_policy_max_positionals_uniq: defineLimit({
        env: 'SHELL_POLICY_MAX_POSITIONALS_UNIQ', default: 1, min: 0, max: 16, unbounded: 16, guard: true,
        doc: 'Positional arguments the uniq policy allows.'
    }),
    shell_policy_max_positionals_xxd: defineLimit({
        env: 'SHELL_POLICY_MAX_POSITIONALS_XXD', default: 1, min: 0, max: 16, unbounded: 16, guard: true,
        doc: 'Positional arguments the xxd policy allows.'
    }),
    shell_policy_max_positionals_date: defineLimit({
        env: 'SHELL_POLICY_MAX_POSITIONALS_DATE', default: 0, min: 0, max: 16, unbounded: 0, guard: true,
        doc: 'Positional arguments the date policy allows.'
    }),
    shell_policy_max_positionals_uname: defineLimit({
        env: 'SHELL_POLICY_MAX_POSITIONALS_UNAME', default: 0, min: 0, max: 16, unbounded: 0, guard: true,
        doc: 'Positional arguments the uname policy allows.'
    }),
    shell_policy_max_positionals_hostname: defineLimit({
        env: 'SHELL_POLICY_MAX_POSITIONALS_HOSTNAME', default: 0, min: 0, max: 16, unbounded: 0, guard: true,
        doc: 'Positional arguments the hostname policy allows.'
    }),
    shell_policy_max_positionals_whoami: defineLimit({
        env: 'SHELL_POLICY_MAX_POSITIONALS_WHOAMI', default: 0, min: 0, max: 16, unbounded: 0, guard: true,
        doc: 'Positional arguments the whoami policy allows.'
    }),
    shell_policy_max_positionals_pwd: defineLimit({
        env: 'SHELL_POLICY_MAX_POSITIONALS_PWD', default: 0, min: 0, max: 16, unbounded: 0, guard: true,
        doc: 'Positional arguments the pwd policy allows.'
    }),
    shell_policy_max_positionals_uptime: defineLimit({
        env: 'SHELL_POLICY_MAX_POSITIONALS_UPTIME', default: 0, min: 0, max: 16, unbounded: 0, guard: true,
        doc: 'Positional arguments the uptime policy allows.'
    }),
    shell_policy_max_positionals_arch: defineLimit({
        env: 'SHELL_POLICY_MAX_POSITIONALS_ARCH', default: 0, min: 0, max: 16, unbounded: 0, guard: true,
        doc: 'Positional arguments the arch policy allows.'
    }),
    shell_policy_max_positionals_sw_vers: defineLimit({
        env: 'SHELL_POLICY_MAX_POSITIONALS_SW_VERS', default: 0, min: 0, max: 16, unbounded: 0, guard: true,
        doc: 'Positional arguments the sw_vers policy allows.'
    }),
    shell_policy_max_positionals_top: defineLimit({
        env: 'SHELL_POLICY_MAX_POSITIONALS_TOP', default: 0, min: 0, max: 16, unbounded: 0, guard: true,
        doc: 'Positional arguments the top policy allows.'
    }),
    shell_policy_max_positionals_tput: defineLimit({
        env: 'SHELL_POLICY_MAX_POSITIONALS_TPUT', default: 2, min: 0, max: 16, unbounded: 16, guard: true,
        doc: 'Positional arguments the tput policy allows.'
    }),
    shell_policy_max_positionals_locale: defineLimit({
        env: 'SHELL_POLICY_MAX_POSITIONALS_LOCALE', default: 2, min: 0, max: 16, unbounded: 16, guard: true,
        doc: 'Positional arguments the locale policy allows.'
    })
});
