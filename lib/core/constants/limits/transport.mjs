// @ts-check
/**
 * @file Transport, retry, circuit-breaker, embedding and telemetry limits.
 * @version 0.12.0
 *
 * @description
 * The knobs that bound one outbound exchange and its recovery: HTTP/gateway
 * timeouts, retry counts and backoff windows, the circuit breaker, embedding
 * retry presets, token-estimation ratios, and the OTel exporter's buffers and
 * post timeout. Defaults are the SDK's documented behaviour; every mutable one
 * is overridable through `MERCI_LIMIT_<ENV>` or `merci-limits.json`.
 */

import { defineLimit } from './define.mjs';

/**
 * Appended to text the `max_error_message_chars` cap cut, so a cut diagnostic
 * is never mistaken for the vendor's whole words.
 */
export const TRUNCATION_MARKER = '…[truncated]';

export const TRANSPORT_LIMITS = Object.freeze({
    jai_header_timeout_ms: defineLimit({
        env: 'JAI_HEADER_TIMEOUT_MS', legacyEnv: ['JAI_HEADER_TIMEOUT_MS'], default: 600_000, min: 1_000, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Header (time-to-first-byte) timeout for JAI streaming chat requests.'
    }),
    oai_request_timeout_ms: defineLimit({
        env: 'OAI_REQUEST_TIMEOUT_MS', default: 600_000, min: 1_000, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Deadline for an OAI-standard request: connect plus response headers, and the body of a non-streaming call.'
    }),
    jai_connect_timeout_ms: defineLimit({
        env: 'JAI_CONNECT_TIMEOUT_MS', legacyEnv: ['JAI_CONNECT_TIMEOUT_MS'], default: 30_000, min: 1_000, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Connect timeout for small JAI control-plane calls (token refresh, profile GETs).'
    }),
    google_token_timeout_ms: defineLimit({
        env: 'GOOGLE_TOKEN_TIMEOUT_MS', default: 30_000, min: 1_000, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Deadline for one Google OAuth token request (the credential exchange or the metadata token fetch).'
    }),
    jai_token_refresh_skew_ms: defineLimit({
        env: 'JAI_TOKEN_REFRESH_SKEW_MS', default: 60_000, min: 0, max: 86_400_000, unbounded: 60_000, timer: true,
        doc: 'How early before `exp` a JAI JWT is treated as expired and refreshed.'
    }),
    gateway_tool_turn_retries: defineLimit({
        env: 'GATEWAY_TOOL_TURN_RETRIES', default: 6, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Retries for a gateway 400 caused by a tool-message turn or role conversion.'
    }),
    retry_after_max_ms: defineLimit({
        env: 'RETRY_AFTER_MAX_MS', default: 60_000, min: 0, max: 86_400_000, unbounded: 60_000, timer: true,
        doc: 'Upper bound on a server-provided `Retry-After` delay.'
    }),
    max_error_body_bytes: defineLimit({
        env: 'MAX_ERROR_BODY_BYTES', default: 1_048_576, min: 1_024, max: 100_000_000, unbounded: 100_000_000, guard: true,
        doc: 'Bytes read from an error response body before the read is cancelled.'
    }),
    max_error_message_chars: defineLimit({
        env: 'MAX_ERROR_MESSAGE_CHARS', default: 2_048, min: 64, max: 10_000_000, unbounded: 10_000_000, guard: true,
        doc: 'Characters of an error message kept before the `…[truncated]` marker cuts the rest.'
    }),
    sse_max_line_bytes: defineLimit({
        env: 'SSE_MAX_LINE_BYTES', default: 1_048_576, min: 1_024, max: 100_000_000, unbounded: 100_000_000, guard: true,
        doc: 'Longest SSE line accepted before the frame is dropped as malformed.'
    }),
    stream_timeout_ms: defineLimit({
        env: 'STREAM_TIMEOUT_MS', default: 150_000, min: 1_000, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Default per-stream idle timeout.'
    }),
    premature_retry_backoff_ms: defineLimit({
        env: 'PREMATURE_RETRY_BACKOFF_MS', default: 400, min: 0, max: 86_400_000, unbounded: 400, timer: true,
        doc: 'Base delay before re-issuing a stream the provider closed early (grows linearly).'
    }),
    max_premature_attempts: defineLimit({
        env: 'MAX_PREMATURE_ATTEMPTS', default: 3, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Attempts for a stream the provider closes early (content_filter is never retried; an identical cut after content is not retried either).'
    }),
    transient_retry_attempts: defineLimit({
        env: 'TRANSIENT_RETRY_ATTEMPTS', default: 3, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Retries for a 429/5xx JAI response before the error propagates.'
    }),
    transient_backoff_base_ms: defineLimit({
        env: 'TRANSIENT_BACKOFF_BASE_MS', default: 1_000, min: 0, max: 86_400_000, unbounded: 1_000, timer: true,
        doc: 'Base delay for transient JAI retries (doubles per attempt).'
    }),
    transient_backoff_jitter: defineLimit({
        env: 'TRANSIENT_BACKOFF_JITTER', default: 0.2, min: 0, max: 1, unbounded: 0.2, integer: false,
        doc: 'Fraction of +/- random jitter applied to a transient retry delay.'
    }),
    streaming_max_retries: defineLimit({
        env: 'STREAMING_MAX_RETRIES', default: 2, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Streaming/LLM-call retry preset: retries past the first call.'
    }),
    streaming_initial_delay_ms: defineLimit({
        env: 'STREAMING_INITIAL_DELAY_MS', default: 500, min: 0, max: 86_400_000, unbounded: 500, timer: true,
        doc: 'Streaming/LLM-call retry preset: base delay before the first retry.'
    }),
    streaming_max_delay_ms: defineLimit({
        env: 'STREAMING_MAX_DELAY_MS', default: 30_000, min: 0, max: 86_400_000, unbounded: 30_000, timer: true,
        doc: 'Streaming/LLM-call retry preset: upper bound on any single backoff.'
    }),
    default_retry_limit: defineLimit({
        env: 'DEFAULT_RETRY_LIMIT', default: 2, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Default retry count for transient tool/transport failures.'
    }),
    retry_initial_delay_ms: defineLimit({
        env: 'RETRY_INITIAL_DELAY_MS', default: 1_000, min: 0, max: 86_400_000, unbounded: 1_000, timer: true,
        doc: 'ExponentialBackoffPolicy default delay before the first retry.'
    }),
    retry_max_delay_ms: defineLimit({
        env: 'RETRY_MAX_DELAY_MS', default: 30_000, min: 0, max: 86_400_000, unbounded: 30_000, timer: true,
        doc: 'ExponentialBackoffPolicy default upper bound on any single delay.'
    }),
    cause_chain_depth: defineLimit({
        env: 'CAUSE_CHAIN_DEPTH', default: 10, min: 1, max: 1_000, unbounded: 10,
        doc: 'Cause-chain links walked when classifying an error as a timeout or an abort.'
    }),
    retry_max_retries: defineLimit({
        env: 'RETRY_MAX_RETRIES', default: 3, min: 0, max: 1_000, unbounded: 1_000,
        doc: 'Retries a bare ExponentialBackoffPolicy performs when no count is passed.'
    }),
    retry_jitter_ms: defineLimit({
        env: 'RETRY_JITTER_MS', default: 1_000, min: 0, max: 60_000, unbounded: 1_000, timer: true,
        doc: 'Full-jitter marker for the default backoff policy (0 = deterministic delays).'
    }),
    tool_turn_backoff_base_ms: defineLimit({
        env: 'TOOL_TURN_BACKOFF_BASE_MS', default: 200, min: 0, max: 60_000, unbounded: 200, timer: true,
        doc: 'Base delay (ms) before retrying a gateway tool-message turn.'
    }),
    tool_turn_backoff_cap_ms: defineLimit({
        env: 'TOOL_TURN_BACKOFF_CAP_MS', default: 1_000, min: 0, max: 86_400_000, unbounded: 1_000, timer: true,
        doc: 'Upper bound (ms) on a single gateway tool-turn retry delay.'
    }),
    tool_turn_backoff_jitter: defineLimit({
        env: 'TOOL_TURN_BACKOFF_JITTER', default: 0.2, integer: false, min: 0, max: 1, unbounded: 0.2,
        doc: 'Fractional jitter applied around a gateway tool-turn retry delay.'
    }),
    limiter_max_concurrent: defineLimit({
        env: 'LIMITER_MAX_CONCURRENT', default: 1, min: 1, max: 100_000, unbounded: 1,
        doc: 'Concurrent tasks allowed by runBatch() when no option is passed.'
    }),
    limiter_min_delay_ms: defineLimit({
        env: 'LIMITER_MIN_DELAY_MS', default: 0, min: 0, max: 86_400_000, unbounded: 0, timer: true,
        doc: 'Spacing (ms) between task starts in runBatch() when no option is passed.'
    }),
    circuit_failure_threshold: defineLimit({
        env: 'CIRCUIT_FAILURE_THRESHOLD', default: 5, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Consecutive failures before the circuit breaker opens.'
    }),
    circuit_cooldown_ms: defineLimit({
        env: 'CIRCUIT_COOLDOWN_MS', default: 30_000, min: 0, max: 86_400_000, unbounded: 30_000, timer: true,
        doc: 'Time an open circuit breaker waits before its half-open probe.'
    }),
    embed_max_retries: defineLimit({
        env: 'EMBED_MAX_RETRIES', default: 5, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Max retries for a single embedding call.'
    }),
    embed_initial_delay_ms: defineLimit({
        env: 'EMBED_INITIAL_DELAY_MS', default: 2_000, min: 0, max: 86_400_000, unbounded: 2_000, timer: true,
        doc: 'Initial backoff delay between embedding retries.'
    }),
    embed_max_delay_ms: defineLimit({
        env: 'EMBED_MAX_DELAY_MS', default: 60_000, min: 0, max: 86_400_000, unbounded: 60_000, timer: true,
        doc: 'Upper bound on any single embedding retry delay.'
    }),
    max_elapsed_ms: defineLimit({
        env: 'MAX_ELAPSED_MS', default: 0, min: 0, max: 86_400_000, unbounded: 0, timer: true,
        doc: 'Wall-clock budget shared by all retries of one runWithRetry call (0 = no budget).'
    }),
    profile_cache_ttl_ms: defineLimit({
        env: 'PROFILE_CACHE_TTL_MS', default: 3_600_000, min: 0, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'TTL for cached backend profile lookups.'
    }),
    anthropic_max_tokens: defineLimit({
        env: 'ANTHROPIC_MAX_TOKENS', default: 8_192, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Default max output tokens for Anthropic calls.'
    }),
    anthropic_min_thinking_budget: defineLimit({
        env: 'ANTHROPIC_MIN_THINKING_BUDGET', default: 1_024, min: 1, max: 1_000_000, unbounded: 1_024,
        doc: 'Lowest accepted extended-thinking budget; smaller values are clamped up.'
    }),
    web_search_max_results: defineLimit({
        env: 'WEB_SEARCH_MAX_RESULTS', default: 5, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Default `maxResults` for the JAI web-search tool.'
    }),
    safe_stringify_max_nodes: defineLimit({
        env: 'SAFE_STRINGIFY_MAX_NODES', default: 20_000, min: 100, max: 100_000_000, unbounded: 100_000_000, guard: true,
        doc: 'Objects `safeStringify` emits before truncating.'
    }),
    estimate_tokens_chars_per_token: defineLimit({
        env: 'ESTIMATE_TOKENS_CHARS_PER_TOKEN', default: 4, min: 0.1, max: 100, unbounded: 100, integer: false,
        doc: 'Chars per token used when no token counts are available.'
    }),
    default_embedding_dimensions: defineLimit({
        env: 'DEFAULT_EMBEDDING_DIMENSIONS', legacyEnv: ['DEFAULT_JAI_EMBEDDING_DIMENSIONS'], default: 1_024, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Output dimensionality for the JAI embedding endpoint when unset.'
    }),
    otel_batch_size: defineLimit({
        env: 'OTEL_BATCH_SIZE', default: 64, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Buffered spans before the OTel exporter flushes automatically.'
    }),
    otel_flush_interval_ms: defineLimit({
        env: 'OTEL_FLUSH_INTERVAL_MS', default: 5_000, min: 0, max: 86_400_000, unbounded: 5_000, timer: true,
        doc: 'Interval between automatic OTel exporter flushes.'
    }),
    otel_max_runs: defineLimit({
        env: 'OTEL_MAX_RUNS', default: 4_096, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Run indexes the OTel exporter keeps before evicting the oldest.'
    }),
    otel_post_timeout_ms: defineLimit({
        env: 'OTEL_POST_TIMEOUT_MS', default: 10_000, min: 1_000, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Timeout for one OTLP export POST.'
    }),
    otel_attr_max_chars: defineLimit({
        env: 'OTEL_ATTR_MAX_CHARS', default: 256, min: 1, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Cap for a single OTel span attribute value.'
    }),
    run_command_max_buffer_bytes: defineLimit({
        env: 'RUN_COMMAND_MAX_BUFFER_BYTES', default: 10_485_760, min: 1_024, max: 100_000_000, unbounded: 100_000_000, guard: true,
        doc: 'Combined stdout/stderr bytes runCommand and runPipeline buffer before truncating.'
    }),
    run_command_kill_grace_ms: defineLimit({
        env: 'RUN_COMMAND_KILL_GRACE_MS', default: 1_000, min: 0, max: 86_400_000, unbounded: 1_000, timer: true,
        doc: 'Grace between the SIGTERM and SIGKILL sent to a command process group.'
    })
});
