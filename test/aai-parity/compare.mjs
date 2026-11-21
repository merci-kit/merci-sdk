// @ts-check
/**
 * @file Strict comparison for AAI parity fixtures.
 * @version 0.22.0
 *
 * @description
 * Deep comparison with an explicit, documented allowlist. Everything compares
 * exactly except request headers: only `authorization`, `content-type`,
 * `accept`, `anthropic-version` and `x-merci-session-id` are compared, always
 * lowercased. The SDK's own transport headers (`user-agent`, `x-stainless-*`,
 * `connection`, `content-length`, `accept-language`, `sec-fetch-mode`,
 * `accept-encoding`, `host`) are noise this connector does not reproduce and
 * never will.
 *
 * The fixture stores the raw wire requests, so both sides are normalized
 * before the comparison. Mirrors `test/oai-parity/compare.mjs`, whose harness
 * is pinned to the OAI wire and stays untouched.
 */

/** The request headers that are comparable, in output order. */
const REQUEST_HEADERS = ['authorization', 'content-type', 'accept', 'anthropic-version', 'x-merci-session-id'];

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Keeps only the comparable request headers, lowercased, in allowlist order.
 * @param {{headers?: Record<string, any>}} arg0
 * @returns {Record<string, string>}
 */
export function pickRequestHeaders({ headers = {} } = {}) {
    /** @type {Record<string, any>} */
    const lowered = {};
    for (const [name, value] of Object.entries(headers)) lowered[name.toLowerCase()] = value;
    /** @type {Record<string, string>} */
    const picked = {};
    for (const name of REQUEST_HEADERS) {
        if (lowered[name] !== undefined) picked[name] = String(lowered[name]);
    }
    return picked;
}

/**
 * Projects recorded requests into the comparable shape.
 * @param {{requests: Array<{method: string, url: string, headers: Record<string, any>, body: string}>}} arg0
 * @returns {Array<{method: string, url: string, headers: Record<string, string>, body: string}>}
 */
export function normalizeRequests({ requests }) {
    return requests.map((request) => ({
        method: request.method,
        url: request.url,
        headers: pickRequestHeaders({ headers: request.headers }),
        body: request.body,
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
        expected: normalizeRequests({ requests: expected.request }),
        actual: normalizeRequests({ requests: actual.request }),
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
