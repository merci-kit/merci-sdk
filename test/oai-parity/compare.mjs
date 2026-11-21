// @ts-check
/**
 * @file Strict comparison for OAI parity fixtures.
 * @version 0.21.0
 *
 * @description
 * Deep comparison with an explicit, documented allowlist. Everything compares
 * exactly except:
 *   - request headers other than `authorization`, `content-type`, `accept`,
 *     plus any header the case declares in `compare.requestHeaders`;
 *   - `latencyMs` on a `first_token` event (wall-clock noise);
 *   - the non-enumerable `_request_id` the OpenAI SDK attaches to parsed JSON;
 *   - object key order, `-0` vs `0`, `NaN` vs `NaN`, and an `undefined`
 *     property vs an absent one (JSON cannot carry `undefined`).
 * Any other difference is a diff.
 */

/**
 * The request headers that are always comparable.
 */
const BASE_REQUEST_HEADERS = ['authorization', 'content-type', 'accept'];

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Keeps only the comparable request headers, in allowlist order.
 * @param {{headers?: Record<string, any>, extra?: Array<string>}} arg0
 * @returns {Record<string, string>}
 */
export function pickRequestHeaders({ headers = {}, extra = [] }) {
    /** @type {Record<string, string>} */
    const picked = {};
    for (const name of [...BASE_REQUEST_HEADERS, ...extra]) {
        if (headers[name] !== undefined) picked[name] = String(headers[name]);
    }
    return picked;
}

/**
 * Projects recorded requests into the comparable shape.
 * @param {{requests: Array<{method: string, url: string, headers: Record<string, any>, body: string}>, extra?: Array<string>}} arg0
 * @returns {Array<{method: string, url: string, headers: Record<string, string>, body: string}>}
 */
export function normalizeRequests({ requests, extra = [] }) {
    return requests.map((request) => ({
        method: request.method,
        url: request.url,
        headers: pickRequestHeaders({ headers: request.headers, extra }),
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
    if (typeof expected === 'number' && typeof actual === 'number') {
        if (Number.isNaN(expected) && Number.isNaN(actual)) return;
        if (expected === 0 && actual === 0) return;
    }
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
        const isFirstToken = expected.type === 'first_token' || actual.type === 'first_token';
        const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
        for (const key of keys) {
            if (key === '_request_id') continue;
            if (key === 'latencyMs' && isFirstToken) continue;
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
        expected: expected.request,
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
