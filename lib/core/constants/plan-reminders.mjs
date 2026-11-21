// @ts-check
/**
 * @file Prompt strings and events for plan-mode agents.
 * @version 0.12.0
 *
 * @description
 * The system/stage reminders that steer the read-only plan agent (write the
 * plan as todos, end with plan_exit), the reviewer follow-up stage, the
 * extractor persona, and the backward-compatible distillation-error event.
 */




/** Stable code for memory distillation failures. */
export const DISTILLATION_ERROR_CODE = 'MEMORY-DISTILL-FAILED';


/** Appended on the final loop iteration: stop tool calls, stay in persona. */
export const FINAL_ITERATION_REMINDER = '[Final turn: stay strictly within your persona. Do not call any more tools.]';


/** Pushed as a model-visible synthetic user turn after the penultimate tool round: one round remains, next turn must be the final text answer. Separate from FINAL_ITERATION_REMINDER (last-turn system prompt + forced text). Plain user text + stripped injection marker — safe for JAI V9 strict validation, GAI same-role merge, memory accounting. */
export const PENULTIMATE_ITERATION_REMINDER = '[Notice: one tool round remains — finish any last lookup, then you MUST give the final text answer with no more tool calls.]';


/**
 * Default followUp stage: review the produced answer, fix gaps, or reply DONE.
 * Sent as the next user turn for `runAgenticLoop({ followUp })` so the model
 * reviews what it just produced instead of stopping at its first answer.
 * @type {string}
 */
export const REVIEW_STAGE_REMINDER = [
    'Review what you just produced against the original request.',
    'Name anything missing, wrong, unverified, or assumed. Use your tools to check the doubtful parts.',
    'Then give the corrected, complete answer.',
    'If it was already correct and complete, reply with exactly: DONE'
].join(' ');


/** System persona for exact parameter extraction. */
export const DEFAULT_EXTRACTOR_PERSONA = 'You are an exact parameter extraction engine. Extract parameters strictly from the user\'s input to fulfill the required tool call. Do not invent details.';


/** Tool the plan agent must call to finish plan mode. */
export const PLAN_EXIT_TOOL_NAME = 'plan_exit';


/** System-context block injected while the plan agent is active. */
export const PLAN_MODE_REMINDER = [
    'PLAN MODE: you are in read-only planning mode. Only the tools visible to you are available.',
    'The plan is a task list: add plan items with manage_todos (each task = one plan item), track progress by updating statuses, review with load_todos.',
    'Workflow: explore the codebase (when subagent profiles are registered, delegate research via the task tool), design the approach, then write the plan incrementally as tasks.',
    'CRITICAL: your turn must end by calling plan_exit after the plan is written. Never stop with a summary or a plain-text answer instead — plan_exit is the only way to finish.'
].join(' ');


/** System-context block injected on the first run after plan → execute. */
export const BUILD_SWITCH_REMINDER = [
    'Your operational mode changed from plan to execute. You are no longer in read-only mode.',
    'Execute the plan at ${planPath} using your full tool set.'
].join(' ');


/** Auto-queued followUp stage: refuse plain-text answers until plan_exit is called. */
export const PLAN_STAGE_REMINDER = [
    'Your last answer did not finalize the plan: plan_exit was not called.',
    'If the plan is complete, ensure it is written as tasks (manage_todos, statuses reflect progress) and call plan_exit.',
    'If it is not complete, continue researching. Your turn must end with plan_exit.'
].join(' ');

/** Re-exported event registry (canonical definition in ../events.mjs). */
export { EVENTS } from '../events.mjs';
