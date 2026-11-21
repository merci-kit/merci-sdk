// @ts-check
/**
 * @file JAI wire types: parameter keys, SSE event shapes, and error hierarchy.
 * @version 0.12.0
 *
 * @description
 * The unified→V9 parameter key registry (LLMParameters), the structured API /
 * SSE error classes thrown by the JAI transport, and the canonical stream
 * event shapes the transport yields.
 */

import { ProviderType, ProtocolType } from '../../core/constants/index.mjs';
import { BackendError } from '../../core/errors.mjs';

/**
 * One unified-parameter → V9 wire key mapping entry.
 * @typedef {Object} LLMParamDef
 * @property {string} key - The V9 wire key.
 * @property {string} type - The wire value type.
 * @property {boolean} [toolConfig] - True when the entry maps into the nested `toolConfig`.
 * @property {string} [protocol] - ProtocolType this entry is valid for; undefined = every protocol.
 */

/**
 * Unified parameter key → V9 wire key registry. `toolConfig: true` entries
 * map onto the nested `toolConfig` object; the rest map top-level.
 * @typedef {Object} LLMParametersDef
 * @property {LLMParamDef} TEMPERATURE - `{ key: 'temperature', type: 'number' }`.
 * @property {LLMParamDef} TOP_P - `{ key: 'topP', type: 'number' }`.
 * @property {LLMParamDef} TOP_K - `{ key: 'topK', type: 'number' }`.
 * @property {LLMParamDef} LENGTH - `{ key: 'length', type: 'number' }`.
 * @property {LLMParamDef} STOP_TOKEN - `{ key: 'stopToken', type: 'string' }`.
 * @property {LLMParamDef} SEED - `{ key: 'seed', type: 'number' }`.
 * @property {LLMParamDef} RESPONSE_FORMAT - `{ key: 'responseFormat', type: 'object' }`.
 * @property {LLMParamDef} TOOLS - `{ key: 'tools', type: 'array', toolConfig: true }`.
 * @property {LLMParamDef} TOOL_CHOICE_AUTO - `{ key: 'auto', type: 'boolean', toolConfig: true }`.
 * @property {LLMParamDef} TOOL_CHOICE_REQUIRED - `{ key: 'required', type: 'boolean', toolConfig: true }`.
 * @property {LLMParamDef} TOOL_CHOICE_NONE - `{ key: 'none', type: 'boolean', toolConfig: true }`.
 * @property {LLMParamDef} TOOL_CHOICE_NAMED - `{ key: 'named', type: 'string', toolConfig: true }`.
 * @property {LLMParamDef} PARALLEL_TOOL_CALLS - `{ key: 'parallelToolCalls', type: 'boolean', toolConfig: true }`.
 * @property {LLMParamDef} REASONING_EFFORT - `{ key: 'reasoningEffort', type: 'string' }`.
 * @property {LLMParamDef} REASONING_SUMMARY - `{ key: 'reasoningSummary', type: 'string', protocol: 'responses' }`.
 * @property {LLMParamDef} PREDICTED_OUTPUT - `{ key: 'predictedOutput', type: 'string' }`.
 * @property {LLMParamDef} CACHE_POINTS - `{ key: 'cachePoints', type: 'object' }`.
 * @property {LLMParamDef} THINKING_BUDGET - `{ key: 'thinkingBudget', type: 'number' }`.
 * @property {LLMParamDef} NUMBER_OF_CHOICES - `{ key: 'numberOfChoices', type: 'number' }`.
 * @property {LLMParamDef} VERBOSITY - `{ key: 'verbosity', type: 'string' }`.
 * @property {LLMParamDef} PROMPT_CACHE_KEY - `{ key: 'promptCacheKey', type: 'string' }`.
 */

/**
 * @type {LLMParametersDef}
 */
export const LLMParameters = {
    TEMPERATURE: { key: 'temperature', type: 'number' },
    TOP_P: { key: 'topP', type: 'number' },
    TOP_K: { key: 'topK', type: 'number' },
    LENGTH: { key: 'length', type: 'number' },
    STOP_TOKEN: { key: 'stopToken', type: 'string' },
    SEED: { key: 'seed', type: 'number' },
    RESPONSE_FORMAT: { key: 'responseFormat', type: 'object' },
    TOOLS: { key: 'tools', type: 'array', toolConfig: true },
    TOOL_CHOICE_AUTO: { key: 'auto', type: 'boolean', toolConfig: true },
    TOOL_CHOICE_REQUIRED: { key: 'required', type: 'boolean', toolConfig: true },
    TOOL_CHOICE_NONE: { key: 'none', type: 'boolean', toolConfig: true },
    TOOL_CHOICE_NAMED: { key: 'named', type: 'string', toolConfig: true },
    PARALLEL_TOOL_CALLS: { key: 'parallelToolCalls', type: 'boolean', toolConfig: true },
    REASONING_EFFORT: { key: 'reasoningEffort', type: 'string' },
    REASONING_SUMMARY: { key: 'reasoningSummary', type: 'string', protocol: ProtocolType.RESPONSES },
    PREDICTED_OUTPUT: { key: 'predictedOutput', type: 'string' },
    CACHE_POINTS: { key: 'cachePoints', type: 'object' },
    THINKING_BUDGET: { key: 'thinkingBudget', type: 'number' },
    NUMBER_OF_CHOICES: { key: 'numberOfChoices', type: 'number' },
    VERBOSITY: { key: 'verbosity', type: 'string' },
    PROMPT_CACHE_KEY: { key: 'promptCacheKey', type: 'string' }
};

/**
 * @param {{details: any}} arg0
 * @returns {string|undefined}
 */
function vendorCodeFrom({ details }) {
    const code = details?.code ?? details?.error?.code;
    return code === undefined || code === null ? undefined : String(code);
}

/**
 * Base error for JAI transport failures.
 */
export class APIError extends BackendError {
    /**
 * @param {{message: string, status?: number, details?: Record<string, unknown>|null}} arg0
 */
    constructor({ message, status, details }) {
        super({ message, options: {
            status,
            vendorCode: vendorCodeFrom({ details }),
            provider: ProviderType.JAI,
            cause: /** @type {any} */ (details)?.cause,
        } });
        this.name = 'APIError';
        this.details = details;
    }
}

/**
 * A JAI gateway request failed with a non-2xx status.
 */
export class APIStatusError extends APIError {
    /**
 * @param {{message: string, status: number, details?: Record<string, unknown>|null}} arg0
 */
    constructor({ message, status, details }) {
        super({ message, status, details });
        this.name = 'APIStatusError';
    }
}

/**
 * An SSE stream was malformed or corrupted.
 */
export class SSEError extends APIError {
    /**
 * @param {{message: string}} arg0
 */
    constructor({ message }) {
        super({ message, status: undefined, details: undefined });
        this.name = 'SSEError';
    }
}
