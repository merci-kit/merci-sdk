// @ts-check
/**
 * @file Tunable numeric limits and the error-code registry.
 * @version 0.12.0
 *
 * @description
 * Centralizes the SDK's operational caps — iteration/follow-up/replan
 * ceilings, timeouts, compaction threshold, retries — and the stable
 * ERROR_CODES strings that the typed errors in ../errors.mjs carry.
 *
 * The numbers themselves live in `./limits/`, one file per domain. This barrel
 * merges them into `LIMIT_REGISTRY`, derives `LIMIT_DEFAULTS`, and keeps the
 * historical `DEFAULT_*` exports working by reading the registry instead of
 * declaring a second copy.
 */

import { AGENT_LIMITS } from './limits/agent.mjs';
import { PLANNING_LIMITS } from './limits/planning.mjs';
import { TOOLS_LIMITS } from './limits/tools.mjs';
import { TRANSPORT_LIMITS } from './limits/transport.mjs';
import { RUNTIME_LIMITS } from './limits/runtime.mjs';
import { PRESENTATION_LIMITS } from './limits/presentation.mjs';

export { NODE_TIMER_MAX, LIMIT_ENV_PREFIX } from './limits/define.mjs';


/**
 * The shape every registry entry carries (produced by `defineLimit`).
 * @typedef {Readonly<{env: string, legacyEnv: ReadonlyArray<string>, default: number, min?: number, max?: number, unbounded: number, integer: boolean, timer: boolean, guard: boolean, mutable: boolean, doc: string}>} LimitDescriptor
 */

/**
 * Merges the domain registries, refusing a duplicated key or env name.
 * @param {Array<Record<string, LimitDescriptor>>} parts -
 * @returns {Readonly<Record<string, LimitDescriptor>>}
 */
function mergeRegistries(parts) {
    /** @type {Record<string, LimitDescriptor>} */
    const merged = {};
    /** @type {Map<string, string>} */
    const envOwners = new Map();
    for (const part of parts) {
        for (const [key, entry] of Object.entries(part)) {
            if (Object.prototype.hasOwnProperty.call(merged, key)) {
                throw new Error(`duplicate limit key '${key}' in the registry`);
            }
            const env = entry.env;
            const owner = envOwners.get(env);
            if (owner !== undefined) {
                throw new Error(`duplicate limit env '${env}' (keys '${owner}' and '${key}')`);
            }
            envOwners.set(env, key);
            merged[key] = entry;
        }
    }
    return Object.freeze(merged);
}


/** Every tunable limit, keyed by its logical name. */
export const LIMIT_REGISTRY = mergeRegistries([
    /** @type {Record<string, LimitDescriptor>} */ (AGENT_LIMITS),
    /** @type {Record<string, LimitDescriptor>} */ (PLANNING_LIMITS),
    /** @type {Record<string, LimitDescriptor>} */ (TOOLS_LIMITS),
    /** @type {Record<string, LimitDescriptor>} */ (TRANSPORT_LIMITS),
    /** @type {Record<string, LimitDescriptor>} */ (RUNTIME_LIMITS),
    /** @type {Record<string, LimitDescriptor>} */ (PRESENTATION_LIMITS)
]);


/** Default value of every limit, keyed by its logical name. */
export const LIMIT_DEFAULTS = Object.freeze(Object.fromEntries(
    Object.entries(LIMIT_REGISTRY).map(([key, entry]) => [key, entry.default])
));


/**
 * The `DEFAULT_*` exports below are **code defaults**, frozen from the registry
 * at import for compatibility. Behaviour must read `LIMITS.<key>` /
 * `getLimits()`; these numbers never move with an override.
 * @param {string} key -
 * @returns {number}
 */
const defaultValue = (key) => LIMIT_REGISTRY[key].default;


/** Max agentic-loop iterations per run()/step() before forcing a final text answer. */
export const DEFAULT_MAX_ITERATIONS = defaultValue('max_iterations');

/** Max retries for a single embedding call. */
export const EMBED_MAX_RETRIES = defaultValue('embed_max_retries');

/** Initial backoff delay (ms) between embedding retries. */
export const EMBED_INITIAL_DELAY_MS = defaultValue('embed_initial_delay_ms');

/** Consecutive empty model responses tolerated before giving up. */
export const MAX_CONSECUTIVE_EMPTY_RESPONSES = defaultValue('max_consecutive_empty');

/** Corrective retries for a schema-invalid structured deliverable. */
export const DEFAULT_MAX_SCHEMA_RETRIES = defaultValue('max_schema_retries');

/** Safety cap on staged follow-up rounds (opts.followUp). */
export const DEFAULT_MAX_FOLLOW_UPS = defaultValue('max_follow_ups');

/** TTL (ms) for cached backend profile lookups. */
export const PROFILE_CACHE_TTL_MS = defaultValue('profile_cache_ttl_ms');

/** Default per-stream idle timeout (ms). */
export const DEFAULT_STREAM_TIMEOUT_MS = defaultValue('stream_timeout_ms');

/**
 * Every machine-readable code the SDK raises for a timeout. One set, because
 * the retry policy, the scheduler's result normalization and `hasTimeoutCode`
 * must agree: a code missing here is retried as a plain failure, or worse,
 * mistaken for a cancel.
 * @type {ReadonlySet<string>}
 */
export const TIMEOUT_CODES = new Set([
    // The SDK's own four, each raised by a different layer.
    'HEADER_TIMEOUT',
    'BODY_TIMEOUT',
    'STEP_TIMEOUT',
    'STREAM_TIMEOUT',
    // The host-facing spellings a workflow or a Node syscall already uses.
    'ETIMEDOUT',
    'TIMEOUT',
    'timeout'
]);

/** Default shell tool timeout (ms). */
export const SHELL_TOOL_DEFAULT_TIMEOUT_MS = defaultValue('shell_tool_timeout_ms');

/** Truncation cap on shell tool output (characters). */
export const SHELL_TOOL_MAX_OUTPUT_LENGTH = defaultValue('shell_tool_max_output_chars');

/** Max stages in one structured shell pipeline. */
export const SHELL_TOOL_MAX_PIPELINE_STAGES = defaultValue('shell_tool_max_pipeline_stages');

/** Per-output cap when upstream step outputs are inlined into a downstream prompt (characters, visible marker). */
export const MAX_INTAKE_OUTPUT_CHARS = defaultValue('max_intake_output_chars');

/** Estimated token count at which history compaction kicks in. */
export const DEFAULT_COMPACTION_THRESHOLD_TOKENS = defaultValue('compaction_threshold_tokens');

/** Default timeout (ms) for a DAG step paused on manual approval. */
export const DEFAULT_DAG_HITL_TIMEOUT_MS = defaultValue('dag_hitl_timeout_ms');

/** Max times a followUp stage may extend itself. */
export const MAX_FOLLOW_UP_EXTENSIONS = defaultValue('max_follow_up_extensions');

/** Max workflow replans before failing. */
export const DEFAULT_MAX_REPLAN_COUNT = defaultValue('max_replan_count');

/** Max nested-DAG depth (a step with engine:'dag' spawning a child executor). */
export const DEFAULT_DAG_MAX_DEPTH = defaultValue('dag_max_depth');

/** Default cycle-guard ceiling on node visits in a state machine / DAG. */
export const DEFAULT_MAX_VISITS_PER_NODE = defaultValue('max_visits_per_node');

/** Global step ceiling for a state machine (max node visits across the run). */
export const DEFAULT_MAX_MACHINE_STEPS = defaultValue('max_machine_steps');

/** Default retry count for transient tool/transport failures. */
export const DEFAULT_RETRY_LIMIT = defaultValue('default_retry_limit');

/** Streaming/LLM-call retry preset (SOTA scale — matches the OpenAI/Anthropic default of 2): retries past the first call. */
export const STREAMING_MAX_RETRIES = defaultValue('streaming_max_retries');

/** Streaming/LLM-call retry preset: base delay before the first retry (ms). */
export const STREAMING_INITIAL_DELAY_MS = defaultValue('streaming_initial_delay_ms');

/** Streaming/LLM-call retry preset: upper bound on any single backoff (ms). */
export const STREAMING_MAX_DELAY_MS = defaultValue('streaming_max_delay_ms');


/**
 * Stable machine-readable error codes carried by the MerciError hierarchy.
 * The literal is the source of truth: a widening `Object<string, string>` here
 * cost consumers every key's autocompletion and the ability to narrow on one.
 */
export const ERROR_CODES = Object.freeze({
    BASE: 'MERCI-ERR',
    BACKEND: 'MERCI-BACKEND-ERR',
    MEMORY: 'MERCI-MEMORY-ERR',
    CONFIG: 'MERCI-CONFIG-ERR',
    ABORTED: 'MERCI-ABORTED-ERR',
    BUDGET: 'MERCI-BUDGET-ERR',
    MAX_TURNS: 'MERCI-MAX-TURNS-ERR',
    CONCURRENT_RUN: 'MERCI-CONCURRENT-RUN-ERR',
    ABSTRACT_METHOD: 'MERCI-ABSTRACT-METHOD',
    ORCH: 'MERCI-ORCH-ERR',
    ORCH_VERIFY: 'MERCI-ORCH-VERIFY-ERR',
    ORCH_EXHAUSTED: 'MERCI-ORCH-EXHAUSTED-ERR',
    ORCH_GRAPH: 'MERCI-ORCH-GRAPH-ERR',
    ORCH_FAILED: 'MERCI-ORCH-FAILED-ERR',
    GUARDRAIL: 'MERCI-GUARDRAIL-ERR',
    WORKSPACE: 'MERCI-WORKSPACE-ERR',
    SCHEDULER: 'MERCI-SCHEDULER-ERR',
    WORKFLOW_POLICY: 'MERCI-WORKFLOW-POLICY-ERR',
    AGENT_FILE: 'MERCI-AGENT-FILE-ERR',
    WORK_SOURCE: 'MERCI-WORK-SOURCE-ERR',
    MCP_UNKNOWN_TASK: 'MERCI-MCP-UNKNOWN-TASK'
});
