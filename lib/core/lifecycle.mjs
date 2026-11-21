// @ts-check


/**
 * @file Phase lifecycle umbrella.
 * @version 0.12.0
 *
 * @description
 * The third layer of the event system. Events observe (sync, isolated);
 * Hooks intervene (ordered, async); **phases time**. A phase wraps any async
 * unit and emits one uniform pair — `phase:start { phase }` and
 * `phase:end { phase, durationMs, status, error? }` — so a listener can time
 * and correlate every lifecycle unit (a run, a step, a workflow) without
 * knowing each domain's bespoke start/end event names.
 *
 *   on('phase:*', ({ phase, durationMs, status }) => metrics.observe(phase, durationMs));
 *
 * Phase events are ordinary events: sync, isolated, never able to change the
 * wrapped work (a throwing `phase:` listener surfaces as `event:listener_error`
 * and `fn` still runs). `enterPhase` returns `fn`'s value, or rethrows its
 * error after emitting `phase:end { status: 'error' }`.
 */


import { EVENTS, emitEvent } from './events.mjs';


/**
 * Canonical phase names. One umbrella spans every engine, so the name is what
 * the unit is (not which engine ran it).
 */
export const PHASES = Object.freeze({
    RUN: 'run',
    STEP: 'step',
    WORKFLOW: 'workflow',
});


/**
 * Runs `fn` inside a named lifecycle phase, emitting `phase:start` before and
 * `phase:end` after. The correlation context is the explicit `ctx.runContext`
 * or the ambient one; `ctx.emitter` is required for anything to be emitted.
 * @template T
 * @param {{ctx?: {emitter?: import('node:events').EventEmitter|null, runContext?: import('./events.mjs').RunContext|null}, phase: string, fn: () => T|Promise<T>}} arg0
 * @returns {Promise<T>}
 */
export async function enterPhase({ ctx = {}, phase, fn }) {
    const { emitter = null, runContext = null } = ctx;
    const startedAt = Date.now();
    emitEvent({ emitter, name: EVENTS.PHASE.START, payload: { phase }, runContext });
    try {
        const result = await fn();
        emitEvent({ emitter, name: EVENTS.PHASE.END, payload: { phase, durationMs: Date.now() - startedAt, status: 'success' }, runContext });
        return result;
    } catch (error) {
        emitEvent({ emitter, name: EVENTS.PHASE.END, payload: {
            phase,
            durationMs: Date.now() - startedAt,
            status: 'error',
            error: (/** @type {{message?: any}} */ (error))?.message ?? String(error),
        }, runContext });
        throw error;
    }
}
