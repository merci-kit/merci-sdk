// @ts-check

/**
 * @file Agent outcome policy: fallback classification, guards, stream errors.
 * @version 0.12.0
 */
import { ERROR_CODES, FALLBACK_MESSAGE } from '../core/constants/index.mjs';
import { ConfigurationError, MerciError } from '../core/errors.mjs';
import { EMPTY_OUTPUT_CODE } from '../support/retry-policy.mjs';

/**
 * an object's `content` wins, anything else is JSON-stringified.
 * @param {{raw: unknown}} arg0
 * @returns {string}
 */
export function normalizeAgentOutput({ raw }) {
    if (raw == null) return '';
    if (typeof raw === 'object') {
        const content = /** @type {{content?: string}} */ (raw).content;
        return content ?? JSON.stringify(raw);
    }
    return String(raw);
}

/** @param {{msg: *}} arg0 */
const _fallbackKey = ({ msg }) => msg.split('.')[0];
const MAX_ITERATIONS_KEY = _fallbackKey({ msg: FALLBACK_MESSAGE.MAX_ITERATIONS });
const EMPTY_RESPONSE_KEY = _fallbackKey({ msg: FALLBACK_MESSAGE.EMPTY_RESPONSE });
const SCHEMA_VALIDATION_KEY = _fallbackKey({ msg: FALLBACK_MESSAGE.SCHEMA_VALIDATION });
const CONTENT_FILTERED_KEY = _fallbackKey({ msg: FALLBACK_MESSAGE.CONTENT_FILTERED });

/**
 * Human-readable cause for an agent turn that ended on the SDK empty-response
 * fallback. Shared by the MAA ledger and the DAG executor's retry classifier.
 */
export const EMPTY_FALLBACK_CAUSE = 'empty-response fallback (no text after the tool round)';

/**
 * Human-readable cause for an agent turn that exhausted its structured-output
 * correction retries. Distinct from {@link EMPTY_FALLBACK_CAUSE} so a consumer
 * can tell a schema miss apart from a plain empty answer.
 */
export const SCHEMA_FALLBACK_CAUSE = 'schema-validation fallback (no valid JSON after correction attempts)';

/**
 * @param {{text: string}} arg0
 * @returns {'max_iterations'|'empty'|'schema'|'filtered'|null}
 */
export function fallbackKind({ text }) {
    if (typeof text !== 'string' || !text.trim()) return null;
    if (text.startsWith(MAX_ITERATIONS_KEY)) return 'max_iterations';
    if (text.startsWith(SCHEMA_VALIDATION_KEY)) return 'schema';
    if (text.startsWith(EMPTY_RESPONSE_KEY)) return 'empty';
    if (text.startsWith(CONTENT_FILTERED_KEY)) return 'filtered';
    return null;
}

/** @param {{kind: string|null|undefined}} arg0 @returns {boolean} */
export function isTransientFallbackKind({ kind }) {
    return kind === 'empty' || kind === 'schema';
}

/** @param {{text: string}} arg0 @returns {boolean} */
export function isSdkFallbackOutput({ text }) {
    return fallbackKind({ text }) !== null;
}

const NON_RETRYABLE_STREAM_ERROR = /safety|content.?filter|recitation|blocklist|prohibited|timeout|refusal|incomplete|pause_turn/i;

/**
 * @param {{error: {type?: string, error_message?: string, error_type?: string, status?: number}|null|undefined}} arg0
 * @returns {Error & { streamEvent?: unknown, nonRetryable?: boolean, status?: number, code?: string, type?: string }}
 */
export function streamErrorToRetryError({ error }) {
    const ev = error ?? {};
    const kind = `${ev.error_type ?? ''} ${ev.error_message ?? ''}`;
    const err = /** @type {Error & { streamEvent?: unknown, nonRetryable?: boolean, status?: number, code?: string, type?: string }} */ (
        new Error(ev.error_message || ev.error_type || 'stream error'));
    const status = typeof ev.status === 'number' ? ev.status : null;
    if (status !== null) err.status = status;
    if (typeof ev.error_type === 'string' && ev.error_type) {
        err.code = ev.error_type;
        err.type = ev.error_type;
    }
    if (NON_RETRYABLE_STREAM_ERROR.test(kind) || (status !== null && status >= 400 && status < 500 && status !== 429)) {
        err.nonRetryable = true;
    } else if (status === null) {
        err.status = 500;
    }
    err.streamEvent = error;
    return err;
}

/** @param {{flag: unknown, label: string}} arg0 */
export function assertNotInFlight({ flag, label }) {
    if (flag) {
        throw new MerciError({ message: label, options: { code: ERROR_CODES.CONCURRENT_RUN } });
    }
}

/** @param {{verdict: unknown, label: string}} arg0 */
export function assertVerifyVerdict({ verdict, label }) {
    const passed = verdict && typeof verdict === 'object' ? /** @type {{passed?: unknown}} */ (verdict).passed : undefined;
    if (!verdict || typeof verdict !== 'object' || typeof passed !== 'boolean') {
        throw new ConfigurationError({ message: `${label} verify must return { passed, evidence }`, options: { option: 'verify' } });
    }
}

/** @param {{text: string|null|undefined, what?: string}} arg0 @returns {string} */
export function assertUsableOutput({ text, what = 'output' }) {
    const value = text ?? '';
    if (isSdkFallbackOutput({ text: value }) || !value.trim()) {
        const err = new Error(what);
        /** @type {any} */ (err).code = EMPTY_OUTPUT_CODE;
        throw err;
    }
    return value;
}

/** @param {{detail: string}} arg0 @returns {string} */
export function schemaCorrection({ detail }) {
    return `Your previous output did not match the required stateSchema: ${detail}. Return output matching the schema.`;
}

/** @param {{source?: ({autoExtend?: boolean|Object, errorHandlers?: Object|null})|null, autoExtend?: boolean|Object, errorHandlers?: Object|null}} arg0 */
export function resolveExhaustionOpts({ source, autoExtend = false, errorHandlers = null }) {
    const resolvedAutoExtend = source?.autoExtend ?? autoExtend;
    const resolvedErrorHandlers = source?.errorHandlers ?? errorHandlers;
    return {
        ...(resolvedAutoExtend ? { autoExtend: resolvedAutoExtend } : {}),
        ...(resolvedErrorHandlers ? { errorHandlers: resolvedErrorHandlers } : {})
    };
}
