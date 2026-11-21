// @ts-check


/**
 * @file Public surface of the scheduler modules.
 * @version 0.12.0
 *
 * @description
 * The barrel grows with each stage. Today it exposes work-item normalization,
 * dispatch ordering, the four work-source adapters, the two claim stores, the
 * two attempt stores, the scheduler class, the engine runner, and the claim
 * vocabulary/defaults; budget enforcement and the remaining lifecycle surface
 * land in their own stages.
 *
 * Only the intended public surface is re-exported (§3.14). `isActiveState`,
 * `isTerminalState`, `toEpochMs`, and the `work-sources/records.mjs` helpers
 * stay internal; a test that needs them imports the module directly.
 */
export { normalizeWorkItem, sortForDispatch } from './normalize.mjs';
export { createMemoryWorkSource, createJsonFileWorkSource, createFunctionWorkSource, createTodoWorkSource, WORK_SOURCE_CATEGORIES } from './work-sources/index.mjs';
export { createMemoryClaimStore, createFileClaimStore } from './claims.mjs';
export { createMemoryAttemptStore, createFileAttemptStore } from './attempt-store.mjs';
export { WorkScheduler } from './scheduler.mjs';
export { createEngineRunner } from './runner.mjs';
export { CLAIM_STATES, SCHEDULER_DEFAULTS } from './state.mjs';
