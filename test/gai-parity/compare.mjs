// @ts-check
/**
 * @file Strict comparison for GAI parity fixtures.
 * @version 0.22.0
 *
 * @description
 * Deep comparison with an explicit, documented allowlist. Everything compares
 * exactly except:
 *   - request headers other than `content-type`, `x-goog-api-key`,
 *     `authorization`, plus any header the case declares in
 *     `compare.requestHeaders`;
 *   - object key order and the JSON body's key order (the SDK reorders keys, so
 *     both bodies are parsed and deep-sorted before the comparison);
 *   - `undefined` vs an absent property (JSON cannot carry `undefined`).
 * Any other difference is a diff. The SDK's own transport headers
 * (`accept`, `user-agent`, `x-goog-api-client`, `connection`, `content-length`,
 * `host`) are noise this connector does not reproduce and never will.
 *
 * Mirrors `test/oai-parity/compare.mjs`, with the GAI header allowlist and the
 * body projection the Gemini wire needs.
 */

/** The request headers that are comparable, in output order. */
const BASE_REQUEST_HEADERS = ['content-type', 'x-goog-api-key', 'authorization'];

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep key sort, so two encodings of the same object compare equal.
 * @param {any} value
 * @returns {any}
 */
function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (!isObject(value)) return value;
    /** @type {Record<string, any>} */
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
    return sorted;
}

/**
 * One request body as the comparison sees it: parsed and deep-sorted JSON, or
 * the raw text when it is empty or not JSON.
 * @param {unknown} body
 * @returns {any}
 */
function projectBody(body) {
    const text = typeof body === 'string' ? body : '';
    if (text.trim() === '') return '';
    try {
        return sortKeys(JSON.parse(text));
    } catch {
        return text;
    }
}

/**
 * Keeps only the comparable request headers, lowercased, in allowlist order.
 * @param {{headers?: Record<string, any>, extra?: Array<string>}} arg0
 * @returns {Record<string, string>}
 */
export function pickRequestHeaders({ headers = {}, extra = [] } = {}) {
    /** @type {Record<string, any>} */
    const lowered = {};
    for (const [name, value] of Object.entries(headers)) lowered[name.toLowerCase()] = value;
    /** @type {Record<string, string>} */
    const picked = {};
    for (const name of [...BASE_REQUEST_HEADERS, ...extra]) {
        if (lowered[name] !== undefined) picked[name] = String(lowered[name]);
    }
    return picked;
}

/**
 * Projects recorded requests into the comparable shape.
 * @param {{requests: Array<{method: string, url: string, headers: Record<string, any>, body: string}>, extra?: Array<string>}} arg0
 * @returns {Array<{method: string, url: string, headers: Record<string, string>, body: any}>}
 */
export function normalizeRequests({ requests, extra = [] }) {
    return requests.map((request) => ({
        method: request.method,
        url: request.url,
        headers: pickRequestHeaders({ headers: request.headers, extra }),
        body: projectBody(request.body),
    }));
}

/**
 * JSON projection, matching what a fixture file can carry.
 * @param {any} value
 * @returns {any}
 */
export function jsonValue(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Appends one diff per differing leaf.
 * @param {{expected: any, actual: any, path: string, diffs: Array<{path: string, expected: any, actual: any}>}} arg0
 * @returns {void}
 */
function diffInto({ expected, actual, path, diffs }) {
    if (expected === actual) return;
    if (Array.isArray(expected) || Array.isArray(actual)) {
        if (!Array.isArray(expected) || !Array.isArray(actual)) {
            diffs.push({ path, expected, actual });
            return;
        }
        if (expected.length !== actual.length) {
            diffs.push({ path: `${path}.length`, expected: expected.length, actual: actual.length });
            return;
        }
        for (let index = 0; index < expected.length; index += 1) {
            diffInto({ expected: expected[index], actual: actual[index], path: `${path}[${index}]`, diffs });
        }
        return;
    }
    if (isObject(expected) && isObject(actual)) {
        const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
        for (const key of keys) {
            const expectedValue = expected[key];
            const actualValue = actual[key];
            if (expectedValue === undefined && actualValue === undefined) continue;
            if (expectedValue === undefined && !(key in actual)) continue;
            if (actualValue === undefined && !(key in expected)) continue;
            diffInto({ expected: expectedValue, actual: actualValue, path: path ? `${path}.${key}` : key, diffs });
        }
        return;
    }
    diffs.push({ path, expected, actual });
}

/**
 * Compares one replay against one fixture.
 * @param {{case: any, expected: any, actual: {request: Array<any>, outcome: any}}} arg0
 * @returns {Array<{path: string, expected: any, actual: any}>}
 */
export function compareCase({ case: caseDef, expected, actual }) {
    /** @type {Array<{path: string, expected: any, actual: any}>} */
    const diffs = [];
    diffInto({ expected: expected.case, actual: jsonValue(caseDef), path: 'case', diffs });
    diffInto({
        expected: expected.response,
        actual: jsonValue(caseDef.responses ?? caseDef.response),
        path: 'response',
        diffs,
    });
    diffInto({
        expected: normalizeRequests({ requests: expected.request, extra: caseDef.compare?.requestHeaders ?? [] }),
        actual: normalizeRequests({ requests: actual.request, extra: caseDef.compare?.requestHeaders ?? [] }),
        path: 'request',
        diffs,
    });
    diffInto({ expected: expected.outcome, actual: actual.outcome, path: 'outcome', diffs });
    return diffs;
}

/**
 * One-line rendering of a diff, used in assertion messages.
 * @param {{path: string, expected: any, actual: any}} diff
 * @returns {string}
 */
export function formatDiff(diff) {
    return `${diff.path}: expected ${JSON.stringify(diff.expected)}, got ${JSON.stringify(diff.actual)}`;
}
