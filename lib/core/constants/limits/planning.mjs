// @ts-check
/**
 * @file State-machine and planning limits.
 * @version 0.12.0
 *
 * @description
 * The knobs that bound one workflow run: machine step and visit ceilings,
 * plan-attempt and replan budgets, intake/upstream prompt caps, structured-call
 * deadlines and evaluator cadence. Defaults are the SDK's documented behaviour;
 * every one is overridable through `MERCI_LIMIT_<ENV>` or `merci-limits.json`.
 *
 * `dag_max_depth` declares `unbounded` equal to its default: the switch cannot
 * meaningfully unbound a recursion depth, so it holds the documented value.
 */

import { defineLimit } from './define.mjs';

export const PLANNING_LIMITS = Object.freeze({
    max_machine_steps: defineLimit({
        env: 'MAX_MACHINE_STEPS', default: 100, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Global node-visit ceiling across one state machine run.'
    }),
    max_visits_per_node: defineLimit({
        env: 'MAX_VISITS_PER_NODE', default: 10, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Cycle-guard ceiling on visits to a single state-machine or DAG node.'
    }),
    machine_max_context_entries: defineLimit({
        env: 'MACHINE_MAX_CONTEXT_ENTRIES', default: 20, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Context entries a state-machine plan keeps between nodes.'
    }),
    machine_plan_attempts: defineLimit({
        env: 'MACHINE_PLAN_ATTEMPTS', default: 3, min: 1, max: 1_000, unbounded: 1_000,
        doc: 'LLM attempts the state machine allows for one plan before failing.'
    }),
    condition_timeout_ms: defineLimit({
        env: 'CONDITION_TIMEOUT_MS', default: 500, min: 1, max: 86_400_000, unbounded: 86_400_000, timer: true, guard: true,
        doc: 'Hard timeout (ms) for evaluating one state-machine transition condition.'
    }),
    condition_max_length: defineLimit({
        env: 'CONDITION_MAX_LENGTH', default: 4_096, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Characters allowed in one state-machine transition condition expression (a planner writes untrusted input).'
    }),
    condition_memory_mb: defineLimit({
        env: 'CONDITION_MEMORY_MB', default: 128, min: 16, max: 1_024, unbounded: 128, guard: true,
        doc: 'Heap cap (MB) for the isolated process that evaluates one transition condition; a crash cap, held under the kill switch.'
    }),
    condition_unisolated_vm: defineLimit({
        env: 'CONDITION_UNISOLATED_VM', default: 0, min: 0, max: 1, unbounded: 0,
        doc: 'Allow in-process evaluation when child processes are denied (1 = accept losing the memory bound); 0 refuses.'
    }),
    max_intake_output_chars: defineLimit({
        env: 'MAX_INTAKE_OUTPUT_CHARS', default: 8_000, min: 100, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Per-output cap when upstream step outputs are inlined into a downstream prompt.'
    }),
    dag_hitl_timeout_ms: defineLimit({
        env: 'DAG_HITL_TIMEOUT_MS', default: 300_000, min: 1, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'How long (ms) a DAG step waits on manual approval before timing out.'
    }),
    dag_max_depth: defineLimit({
        env: 'DAG_MAX_DEPTH', default: 1, min: 0, max: 1_000_000, unbounded: 1,
        doc: 'Nested-DAG depth allowed when a step spawns a child executor.'
    }),
    max_replan_count: defineLimit({
        env: 'MAX_REPLAN_COUNT', default: 3, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Workflow replans allowed before the run fails.'
    }),
    plan_max_replans: defineLimit({
        env: 'PLAN_MAX_REPLANS', default: 3, min: 0, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Plan patches a single workflow run may apply.'
    }),
    plan_evaluate_every: defineLimit({
        env: 'PLAN_EVALUATE_EVERY', default: 1, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Completed nodes between plan evaluations (a gate node always evaluates).'
    }),
    plan_max_concurrency: defineLimit({
        env: 'PLAN_MAX_CONCURRENCY', default: 0, min: 0, max: 1_000_000, unbounded: 0,
        doc: 'Steps a workflow wave may run at once (0 = unbounded).'
    }),
    plan_fingerprint_replans: defineLimit({
        env: 'PLAN_FINGERPRINT_REPLANS', default: 4, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Replans kept per failure fingerprint before the run stops retrying it.'
    }),
    planner_max_attempts: defineLimit({
        env: 'PLANNER_MAX_ATTEMPTS', default: 3, min: 1, max: 1_000, unbounded: 1_000,
        doc: 'LLM attempts for one structured planner call.'
    }),
    tool_capture_repairs: defineLimit({
        env: 'TOOL_CAPTURE_REPAIRS', default: 3, min: 0, max: 1_000, unbounded: 1_000,
        doc: 'Repair rounds when a model answers in prose instead of tool capture.'
    }),
    structured_call_timeout_ms: defineLimit({
        env: 'STRUCTURED_CALL_TIMEOUT_MS', default: 150_000, min: 1, max: 86_400_000, unbounded: 86_400_000, timer: true,
        doc: 'Total deadline (ms) for one structured planner, evaluator or judge call.'
    }),
    evaluator_outage_attempts: defineLimit({
        env: 'EVALUATOR_OUTAGE_ATTEMPTS', default: 2, min: 1, max: 1_000, unbounded: 1_000,
        doc: 'Evaluator attempts before a step ships its output unverified.'
    }),
    evaluator_digest_chars: defineLimit({
        env: 'EVALUATOR_DIGEST_CHARS', default: 600, min: 100, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Chars kept per completed prerequisite in the evaluator digest.'
    }),
    noop_patch_limit: defineLimit({
        env: 'NOOP_PATCH_LIMIT', default: 2, min: 1, max: 1_000, unbounded: 1_000,
        doc: 'Consecutive empty replan patches tolerated before evaluation stops.'
    }),
    row_cap_floor: defineLimit({
        env: 'ROW_CAP_FLOOR', default: 200, min: 0, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Floor (chars) applied when capping a chat row for a prompt.'
    }),
    shared_session_history_chars: defineLimit({
        env: 'SHARED_SESSION_HISTORY_CHARS', default: 8_000, min: 0, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Inherited conversation chars a shared-session group may carry.'
    }),
    upstream_inline_chars: defineLimit({
        env: 'UPSTREAM_INLINE_CHARS', default: 8_000, min: 100, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Chars of an upstream step output inlined into a downstream prompt.'
    }),
    upstream_inline_min_chars: defineLimit({
        env: 'UPSTREAM_INLINE_MIN_CHARS', default: 2_000, min: 0, max: 100_000_000, unbounded: 100_000_000,
        doc: 'Compact-mode cap (chars) for an inlined upstream step output.'
    }),
    intake_artifact_threshold: defineLimit({
        env: 'INTAKE_ARTIFACT_THRESHOLD', default: 0, min: 0, max: 100_000_000, unbounded: 0,
        doc: 'Output size (chars) above which intake output is saved to an artifact (0 = off).'
    }),
    swarm_turn_floor: defineLimit({
        env: 'SWARM_TURN_FLOOR', default: 1, min: 1, max: 1_000_000, unbounded: 1_000_000,
        doc: 'Token floor a swarm (discussion) step\'s child budget is raised to.'
    })
});
