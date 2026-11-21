// @ts-check


/**
 * @file The refresh classification shared by the scheduler's refresh paths.
 * @version 0.12.0
 *
 * @description
 * `#reconcile`, `#checkParked`, and `#processDueRetries` all ask one question
 * of a refreshed record: is it gone, finished, no longer active, or still
 * live? Only the action per answer differs, and deliberately so, so the
 * classification lives here while every caller keeps its own ladder.
 *
 * Routability is not part of this decision. `#reconcile` and
 * `#processDueRetries` consult it after `live`; `#checkParked` intentionally
 * does not, because parking is a wait rather than a dispatch.
 */
import { isActiveState, isTerminalState } from './normalize.mjs';

/**
 * The refresh outcome: absent from the fetch, in a terminal state, in a state
 * that is no longer active, or still live.
 * @typedef {'missing'|'terminal'|'inactive'|'live'} RefreshOutcome
 */

/**
 * Classify one refreshed record. A missing record wins over everything, and a
 * terminal state wins over inactive.
 * @param {{
 *   item: import('./normalize.mjs').WorkItem|undefined,
 *   terminalStates: import('./normalize.mjs').StateList,
 *   activeStates: import('./normalize.mjs').StateList
 * }} arg0 -
 * @returns {RefreshOutcome}
 */
export function classifyRefresh({ item, terminalStates, activeStates }) {
    if (!item) return 'missing';
    if (isTerminalState({ state: item.state, states: terminalStates })) return 'terminal';
    if (!isActiveState({ state: item.state, states: activeStates })) return 'inactive';
    return 'live';
}
