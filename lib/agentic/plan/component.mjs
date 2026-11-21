// @ts-check


/**
 * @file Plan agent — read-only planning phase with an approval-gated handoff.
 * @version 0.12.0
 *
 * @description
 * The plan agent pairs a permission ruleset (default: deny everything) with an
 * explicit allowlist — the caller's read-only tools (`withPlanTools`), the
 * todos tools (`withTodos`, which is where the plan lives: tasks = plan items,
 * statuses = progress), and the `task` delegation tool. `withExecute()`
 * switches back to the full tool set; the first run after the switch carries a
 * build-switch reminder naming the plan store.
 *
 * Handoff: the model calls `plan_exit` when the plan is final. The tool blocks
 * on an `ApprovalCoordinator` (HITL); the caller resolves it via
 * `session.approvePlanExit(...)` from an event handler / UI, or lets the
 * timeout auto-decline. Approval does not switch agents — the caller then
 * executes (DAG executor or `withExecute()`).
 */
import { PLAN_EXIT_TOOL_NAME, PLAN_STAGE_REMINDER } from '../../core/constants/index.mjs';
import { EVENTS, emitEvent } from '../../core/events.mjs';
import { markBuiltIn } from '../../core/builtin-brand.mjs';
/**
 * @typedef {Object} PlanSession
 * @property {boolean} _planExitRequested
 * @property {{_filePath: string|null}|null} [_todoComponent]
 * @property {import('node:events').EventEmitter|null|undefined} [eventEmitter]
 * @property {{wait: (arg0: {signal: AbortSignal|null}) => Promise<{approved: boolean}>, timedOut?: boolean}} _planExitCoordinator
 */



/** Plan-agent identity (read-only). */
export const AGENT_PLAN = 'plan';

/** Execute-agent identity (full tool set). */
export const AGENT_EXECUTE = 'execute';




/**
 * the `*` wildcard is the fallback, and a nameless tool is never allowed.
 * @param {{name: string|null, rules: Record<string, string>}} arg0 -
 * @returns {boolean}
 */
export function isToolAllowed({ name, rules }) {
    if (!name) return false;
    const rule = rules[name] ?? rules['*'];
    return rule !== 'deny';
}


/**
 * emits `plan:exit_requested` before waiting and `plan:exit_resolved` after.
 * Declined/timeout keeps the agent in plan mode; approval tells the model to
 * conclude its turn — the caller then executes the plan.
 * @param {{session: PlanSession}} arg0 - The ChatSession (must expose eventEmitter and _planExitCoordinator).
 * @returns {Record<string, unknown>} a standard Merci SDK tool definition.
 */
export function createPlanExitTool({ session }) {
    return markBuiltIn({ tool: {
        name: PLAN_EXIT_TOOL_NAME,
        description: 'Signal that the plan (the task list) is complete and request approval to switch to execution. Call this only after the plan is finalized.',
        parameters: { type: 'object', properties: { _: { type: 'string' } }, required: [] },
        /** @param {{signal: *}} arg0 */
        execute: async ({ signal }) => {
            session._planExitRequested = true;
            const planPath = session._todoComponent?._filePath ?? null;
            /** @param {{name: *, payload: *}} arg0 */
            /** @param {{name: *, payload: *}} arg0 */
            const emit = ({ name, payload }) => emitEvent({ emitter: session.eventEmitter ?? null, name, payload });
            emit({ name: EVENTS.PLAN.EXIT_REQUESTED, payload: { planPath } });
            const approval = await session._planExitCoordinator.wait({ signal });
            emit({ name: EVENTS.PLAN.EXIT_RESOLVED, payload: {
                planPath,
                approved: approval.approved,
                timedOut: session._planExitCoordinator?.timedOut ?? false
            } });
            if (!approval.approved) {
                return { success: false, approved: false, message: 'Plan approval declined. Remain in plan mode and keep refining the plan.' };
            }
            return { success: true, approved: true, message: 'Plan approved. Conclude your turn with a final summary; the plan will be executed.' };
        }
    } });
}


/**
 * until plan_exit has been called this run. Each stage that ends without the
 * flag queues PLAN_STAGE_REMINDER as the next user turn (budget capped by
 * maxFollowUps in runAgenticLoop). Declined/timeout still counts as called —
 * the run ends and the agent stays in plan mode.
 * @param {{session: PlanSession}} arg0 - The ChatSession.
 * @returns {(ctx: {round: number}) => (string|null)} the followUp callback.
 */
export function createPlanStageFollowUp({ session }) {
    return () => (session._planExitRequested ? null : PLAN_STAGE_REMINDER);
}
