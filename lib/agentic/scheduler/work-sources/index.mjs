// @ts-check


/**
 * @file Public surface of the work-source adapters.
 * @version 0.12.0
 *
 * @description
 * Four read-only adapters behind one contract: memory, a JSON-file directory,
 * a host function, and the SDK's own todo store. `WORK_SOURCE_CATEGORIES` is the
 * frozen §11.4 vocabulary a `WorkSourceError.category` may use; the scheduler
 * branches only on success/failure, so the category is diagnostic.
 *
 * `records.mjs` stays internal: the asymmetry belongs to the adapters, and a
 * caller that wants a single-record policy should use `normalizeWorkItem`.
 *
 * Identity: ids are compared after `trim()`, the same normalization
 * `normalizeWorkItem` applies, so `' MER-1 '` and `'MER-1'` name one item. Two
 * raw records whose ids differ only by surrounding whitespace are one id: the
 * first wins and each extra is a `duplicate_id` skip (the function list path
 * takes the host's answer as-is; see its header). A JSON file stem that cannot name an id on every platform is refused as `unsafe_id`. List-path
 * dedupe runs after the state filter, so an out-of-state duplicate cannot
 * shadow a live one.
 *
 * Every operation accepts an optional `signal` and honors it: an aborted signal
 * throws `AbortedError` at entry and after each awaited step, and that error
 * passes through unchanged — it is never a `WorkSourceError`.
 */
import { WORK_SOURCE_CATEGORIES as CATEGORY_VALUES } from '../../../core/constants/work-sources.mjs';

/** @typedef {import('../../../core/errors.mjs').WorkSourceCategory} WorkSourceCategory */

/**
 * The Symphony §11.4 categories, in their canonical order.
 * @type {ReadonlyArray<WorkSourceCategory>}
 */
export const WORK_SOURCE_CATEGORIES = CATEGORY_VALUES;

export { createMemoryWorkSource } from './memory.mjs';
export { createJsonFileWorkSource } from './json-file.mjs';
export { createFunctionWorkSource } from './function.mjs';
export { createTodoWorkSource } from './todos.mjs';
