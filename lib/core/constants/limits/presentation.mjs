// @ts-check
/**
 * @file Log, browser, tool-output and on-disk identity length limits.
 * @version 0.12.0
 *
 * @description
 * The knobs that bound what the SDK prints or persists as text: truncation
 * widths for logs and event records, preview caps for tool errors and browser
 * elements, and the fixed hash/slug lengths that name on-disk artifacts.
 * Defaults are the SDK's documented behaviour; every mutable one is
 * overridable through `MERCI_LIMIT_<ENV>` or `merci-limits.json`.
 */

import { defineLimit } from './define.mjs';

export const PRESENTATION_LIMITS = Object.freeze({
    log_truncate_chars: defineLimit({
        env: 'LOG_TRUNCATE_CHARS', default: 200, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Chars kept by the logger when it truncates a line.'
    }),
    log_divider_width: defineLimit({
        env: 'LOG_DIVIDER_WIDTH', default: 56, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Rule characters drawn by the logger divider.'
    }),
    log_indent_width: defineLimit({
        env: 'LOG_INDENT_WIDTH', default: 2, min: 0, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Spaces prepended per logger indentation level.'
    }),
    log_box_min_width: defineLimit({
        env: 'LOG_BOX_MIN_WIDTH', default: 40, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Narrowest box the logger dump renderer will draw before it stops shrinking.'
    }),
    log_box_width: defineLimit({
        env: 'LOG_BOX_WIDTH', default: 60, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Maximum inner width of a logger box.'
    }),
    log_tool_result_chars: defineLimit({
        env: 'LOG_TOOL_RESULT_CHARS', default: 200, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Chars of a tool result body shown at non-debug log levels.'
    }),
    event_log_value_chars: defineLimit({
        env: 'EVENT_LOG_VALUE_CHARS', default: 120, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Chars of a string kept when an event-log field is rendered.'
    }),
    event_log_object_chars: defineLimit({
        env: 'EVENT_LOG_OBJECT_CHARS', default: 160, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Serialized chars allowed before an event-log object is summarized.'
    }),
    event_log_object_keys: defineLimit({
        env: 'EVENT_LOG_OBJECT_KEYS', default: 6, min: 0, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Keys allowed before an event-log object is summarized.'
    }),
    webscrape_stderr_tail_chars: defineLimit({
        env: 'WEBSCRAPE_STDERR_TAIL_CHARS', default: 500, min: 0, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Engine stderr chars kept when a scrape subprocess fails.'
    }),
    policy_hash_chars: defineLimit({
        env: 'POLICY_HASH_CHARS', default: 12, min: 1, max: 12, unbounded: 12, mutable: false,
        doc: 'Fixed on-disk identity length; not configurable: hex chars of a workflow-policy prompt fingerprint.'
    }),
    journal_run_id_chars: defineLimit({
        env: 'JOURNAL_RUN_ID_CHARS', default: 8, min: 1, max: 8, unbounded: 8, mutable: false,
        doc: 'Fixed on-disk identity length; not configurable: chars of a generated journal run id.'
    }),
    stderr_tail_chars: defineLimit({
        env: 'STDERR_TAIL_CHARS', default: 2_000, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Chars of a child process stderr tail attached to an error.'
    }),
    operator_max_field_chars: defineLimit({
        env: 'OPERATOR_MAX_FIELD_CHARS', default: 128, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Chars kept per field in an operator ring entry.'
    }),
    tool_error_schema_lines: defineLimit({
        env: 'TOOL_ERROR_SCHEMA_LINES', default: 5, min: 0, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Schema lines quoted in a tool-argument validation error.'
    }),
    raw_args_preview_chars: defineLimit({
        env: 'RAW_ARGS_PREVIEW_CHARS', default: 200, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Chars of raw tool arguments kept in a repair result preview.'
    }),
    element_label_chars: defineLimit({
        env: 'ELEMENT_LABEL_CHARS', default: 120, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Chars of a browser element label captured for the model.'
    }),
    selector_ancestor_depth: defineLimit({
        env: 'SELECTOR_ANCESTOR_DEPTH', default: 4, min: 0, max: 64, unbounded: 4,
        doc: 'Ancestor levels walked when building a browser element selector.'
    }),
    browser_console_text_chars: defineLimit({
        env: 'BROWSER_CONSOLE_TEXT_CHARS', default: 500, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Chars of one browser console message kept in the buffer.'
    }),
    fix_hint_chars: defineLimit({
        env: 'FIX_HINT_CHARS', default: 500, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Chars of a vendor HTTP response body quoted as a fix hint.'
    }),
    artifacts_collision_retries: defineLimit({
        env: 'ARTIFACTS_COLLISION_RETRIES', default: 100_000, min: 1, max: 10_000_000, unbounded: 10_000_000,
        doc: 'Existing-artifact versions probed before the write gives up.'
    }),
    workspace_key_prefix_chars: defineLimit({
        env: 'WORKSPACE_KEY_PREFIX_CHARS', default: 48, min: 1, max: 48, unbounded: 48, mutable: false,
        doc: 'Fixed on-disk identity length; not configurable: readable prefix chars of a workspace directory key.'
    }),
    workspace_key_hash_chars: defineLimit({
        env: 'WORKSPACE_KEY_HASH_CHARS', default: 16, min: 1, max: 16, unbounded: 16, mutable: false,
        doc: 'Fixed on-disk identity length; not configurable: sha256 suffix chars of a workspace directory key.'
    }),
    attempt_hash_chars: defineLimit({
        env: 'ATTEMPT_HASH_CHARS', default: 32, min: 1, max: 32, unbounded: 32, mutable: false,
        doc: 'Fixed on-disk identity length; not configurable: sha256 suffix chars of a parked-attempt file name.'
    }),
    attempt_slug_chars: defineLimit({
        env: 'ATTEMPT_SLUG_CHARS', default: 48, min: 1, max: 48, unbounded: 48, mutable: false,
        doc: 'Fixed on-disk identity length; not configurable: slug chars of a parked-attempt file name.'
    }),
    graph_hash_chars: defineLimit({
        env: 'GRAPH_HASH_CHARS', default: 12, min: 1, max: 12, unbounded: 12, mutable: false,
        doc: 'Fixed on-disk identity length; not configurable: hex chars of a plan step fingerprint.'
    }),
    session_hash_chars: defineLimit({
        env: 'SESSION_HASH_CHARS', default: 12, min: 1, max: 12, unbounded: 12, mutable: false,
        doc: 'Fixed on-disk identity length; not configurable: hex chars of the session thread id hash.'
    }),
    journal_id_prefix_chars: defineLimit({
        env: 'JOURNAL_ID_PREFIX_CHARS', default: 16, min: 1, max: 16, unbounded: 16, mutable: false,
        doc: 'Fixed on-disk identity length; not configurable: chars of a journal entry key.'
    }),
    otel_row_hash_chars: defineLimit({
        env: 'OTEL_ROW_HASH_CHARS', default: 32, min: 1, max: 32, unbounded: 32, mutable: false,
        doc: 'Fixed on-disk identity length; not configurable: chars of an OTLP row id hash.'
    }),
    otel_event_hash_chars: defineLimit({
        env: 'OTEL_EVENT_HASH_CHARS', default: 16, min: 1, max: 16, unbounded: 16, mutable: false,
        doc: 'Fixed on-disk identity length; not configurable: chars of an OTEL event id hash.'
    }),
    loop_fingerprint_chars: defineLimit({
        env: 'LOOP_FINGERPRINT_CHARS', default: 12, min: 1, max: 12, unbounded: 12, mutable: false,
        doc: 'Fixed on-disk identity length; not configurable: chars of a failure fingerprint.'
    }),
    fs_quarantine_suffix_chars: defineLimit({
        env: 'FS_QUARANTINE_SUFFIX_CHARS', default: 8, min: 1, max: 8, unbounded: 8, mutable: false,
        doc: 'Fixed on-disk identity length; not configurable: chars of a corrupt-file quarantine suffix.'
    }),
    log_run_id_chars: defineLimit({
        env: 'LOG_RUN_ID_CHARS', default: 8, min: 1, max: 8, unbounded: 8, mutable: false,
        doc: 'Fixed on-disk identity length; not configurable: chars of the run id a log line prefixes.'
    }),
    tool_image_max_chars: defineLimit({
        env: 'TOOL_IMAGE_MAX_CHARS', default: 5_242_880, min: 1, max: 100_000_000, unbounded: 100_000_000, guard: true,
        doc: 'Largest inline base64 image payload accepted from a tool result.'
    })
});
