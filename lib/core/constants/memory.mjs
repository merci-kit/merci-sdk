// @ts-check


/**
 * @file Memory-subsystem constants.
 * @version 0.12.0
 *
 * @description
 * Defaults for the memory manager (file path, bank names), the distillation
 * JSON schema, and the audit-trail row bound.
 */
import { z } from 'zod';

import { LIMIT_REGISTRY } from './limits.mjs';


/** Default L1 store path. */
export const DEFAULT_MEMORY_FILE_PATH = './merci-memory.json';

/** Default L1 SQLite store path. */
export const DEFAULT_MEMORY_SQLITE_PATH = './merci-memory.sqlite';

/** Encoding used for memory file reads/writes. */
export const DEFAULT_UTF8_ENCODING = 'utf8';

/** Node fs error code for missing files. */
export const FS_ENOENT_CODE = 'ENOENT';

/** Log prefix for memory-subsystem messages. */
export const LOG_PREFIX_MEMORY = 'Memory';

/** Fallback category for facts without an explicit one. */
export const DEFAULT_MEMORY_CATEGORY = 'general';

/** Prefix of generated fact ids. */
export const MEMORY_FACT_ID_PREFIX = 'fact_';


/** Default single-bank name. */
export const DEFAULT_MEMORY_BANK_NAME = 'workspace';

/** Description shown for the default bank. */
export const DEFAULT_MEMORY_BANK_DESC = 'Default workspace memory for project-specific configurations.';

/** Composite router bank name. */
export const COMPOSITE_MEMORY_BANK_NAME = 'composite';

/** Description shown for the composite bank. */
export const COMPOSITE_MEMORY_BANK_DESC = 'Composite router for multiple memory banks.';


/**
 * Zod schema constraining the distillation engine's output (newFacts, obsoleteFactIds).
 * Converted to JSON Schema at the wire boundary; backends still receive plain JSON Schema.
 * @type {import('zod').ZodType}
 */
export const MEMORY_DISTILLATION_SCHEMA = z.strictObject({
    newFacts: z.array(z.object({
        content: z.string().describe("The extracted declarative fact or user preference."),
        category: z.string().describe("The category of fact (e.g., config, preference, environment)."),
        targetBanks: z.array(z.string()).describe("Array of memory bank names where this fact should be stored.")
    })),
    obsoleteFactIds: z.array(z.string().describe("The IDs of any previously stored facts that are now obsolete or contradicted by the new turns."))
});


/**
 * Rows kept in a memory bank's audit trail (`history`). Bounded like the facts
 * themselves: the trail answers "what did the agent forget or rewrite", not
 * "everything that ever happened".
 *
 * This value is the code default; the effective value is
 * `LIMITS.memory_max_history_rows` / `getLimits()`.
 */
export const MEMORY_MAX_HISTORY_ROWS = LIMIT_REGISTRY.memory_max_history_rows.default;
